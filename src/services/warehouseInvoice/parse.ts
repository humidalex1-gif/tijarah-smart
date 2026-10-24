import ExcelJS from "exceljs";
import { toMinor, toQty } from "@/lib/money";
import { invalidState } from "@/services/errors";

/**
 * Reads Fast Hub's monthly services workbook.
 *
 * The workbook, not the PDF, on purpose. Their PDF carries five summary lines;
 * the workbook carries a row PER ORDER with that order's own packaging,
 * handling, shipping and extra-piece fees — which is the only way the fees can
 * land on the orders that caused them instead of in one undifferentiated
 * lump. A spreadsheet also parses exactly, where a PDF is read by guesswork:
 * the bank's own receipt in the same batch has a corrupted text layer that
 * extracts "إٮ,صال ال%ٮحويل" for "إيصال التحويل".
 *
 * Columns are located BY HEADER TEXT, never by position. Fast Hub generates
 * this file and can reorder or insert a column without telling anyone; a
 * positional parser would then silently read shipping fees as packaging.
 */

const SUMMARY_SHEET = "ملخص الفاتورة";
const ORDERS_SHEET = "تفاصيل الطلبات المرسلة";
const STORAGE_SHEET = "تفاصيل التخزين";

export type InvoiceOrderLine = {
  /** Fast Hub's order number — matches `SalesOrder.externalRef`. */
  externalOrderRef: string;
  shipmentRef: string | null;
  carrier: string | null;
  deliveredAt: Date | null;
  /** SKUs on the order, with the workbook's "(5 KG)" suffix stripped. */
  skus: string[];
  totalPieces: number;
  includedPieces: number;
  extraPieces: number;
  /** Thousandths of a kilogram. */
  weightKg: number;
  /** All in minor units, before tax. */
  packagingFee: number;
  handlingFee: number;
  shippingFee: number;
  extraPieceFee: number;
  totalBeforeTax: number;
  taxAmount: number;
};

export type InvoiceSimpleLine = {
  description: string;
  /** Thousandths. */
  quantity: number;
  /** Minor units, before tax. */
  amount: number;
};

export type ParsedWarehouseInvoice = {
  /** Absent from the workbook; the PDF carries it. Caller supplies a default. */
  invoiceNumber: string | null;
  invoiceDate: Date;
  clientName: string | null;
  shipmentCount: number;
  subtotal: number;
  taxAmount: number;
  total: number;
  summaryLines: InvoiceSimpleLine[];
  orders: InvoiceOrderLine[];
  storage: InvoiceSimpleLine[];
};

type Row = (string | number | null)[];

function sheetRows(workbook: ExcelJS.Workbook, name: string): Row[] {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) return [];
  const rows: Row[] = [];
  sheet.eachRow((row) => {
    const values: Row = [];
    // `row.values` is 1-based with a leading hole; walk the cells instead so
    // an empty leading column cannot shift every index by one.
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const v = cell.value;
      values[col - 1] =
        v === null || v === undefined ? null
          : typeof v === "object" && v instanceof Date ? v.toISOString()
            : typeof v === "object" && "result" in v ? (v.result as string | number)
              : typeof v === "object" && "richText" in v
                ? (v.richText as { text: string }[]).map((r) => r.text).join("")
                : (v as string | number);
    });
    rows.push(values);
  });
  return rows;
}

const text = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "" : String(v).trim();

/** Money in this workbook arrives as binary-float noise: 14.000000000000002. */
const money = (v: string | number | null | undefined) => {
  const n = typeof v === "number" ? v : Number(text(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? toMinor(n) : 0;
};

const count = (v: string | number | null | undefined) => {
  const n = typeof v === "number" ? v : Number(text(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** A cell that is a figure, not prose that happens to contain digits. */
const numeric = (v: string | number | null | undefined) => {
  if (typeof v === "number") return true;
  const s = text(v);
  return s !== "" && /^-?[\d,.\s]+$/.test(s) && Number.isFinite(Number(s.replace(/[,\s]/g, "")));
};

/**
 * Finds a labelled value anywhere in the summary sheet.
 *
 * The label is NOT always in the first column: the header fields sit in A/B,
 * but the three totals are indented into B/C with A empty. Scanning the whole
 * row is what makes both shapes work — reading column A alone returned zero
 * for every total, which is a plausible-looking invoice worth nothing.
 *
 * Merged cells arrive from exceljs as the same value repeated across the span,
 * so a repeat of the label itself is skipped rather than taken as its value.
 */
function labelled(rows: Row[], label: string): string | number | null {
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = text(row[i]);
      if (!cell || !cell.includes(label)) continue;
      for (let j = i + 1; j < row.length; j++) {
        const value = text(row[j]);
        if (value !== "" && value !== cell) return row[j]!;
      }
    }
  }
  return null;
}

export async function parseFastHubInvoice(file: Buffer): Promise<ParsedWarehouseInvoice> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw invalidState("INVOICE_NOT_A_WORKBOOK");
  }

  const summary = sheetRows(workbook, SUMMARY_SHEET);
  if (summary.length === 0) {
    // Loud, not lenient: an empty parse would look like a clean upload that
    // simply found nothing to bill, and post nothing while saying nothing.
    throw invalidState("INVOICE_SHEET_MISSING", { sheet: SUMMARY_SHEET });
  }

  const rawDate = text(labelled(summary, "التاريخ"));
  const invoiceDate = new Date(rawDate);
  if (Number.isNaN(invoiceDate.getTime())) {
    throw invalidState("INVOICE_DATE_UNREADABLE", { value: rawDate });
  }

  // The fee rows sit between the header row and the totals; they are the ones
  // carrying three populated columns.
  const summaryLines: InvoiceSimpleLine[] = [];
  let inTable = false;
  for (const row of summary) {
    const label = text(row[0]);
    if (label === "الوصف") { inTable = true; continue; }
    if (!inTable) continue;
    if (label.startsWith("الإجمالي") || label.startsWith("ضريبة")) break;
    // A fee line carries a numeric quantity AND a numeric amount. Below the
    // table sits the warehouse's own bank block — "البنك / بنك الراجحي /
    // بنك الراجحي" — three populated columns that a shape-only test happily
    // took for a fee of zero. Blank rows cannot be used as the boundary here:
    // exceljs's eachRow skips them entirely, so the table appears to run
    // straight into the footer.
    if (!label || !numeric(row[1]) || !numeric(row[2])) continue;
    summaryLines.push({ description: label, quantity: toQty(count(row[1])), amount: money(row[2]) });
  }

  return {
    invoiceNumber: null,
    invoiceDate,
    clientName: text(labelled(summary, "العميل")) || null,
    shipmentCount: count(labelled(summary, "عدد الشحنات")),
    subtotal: money(labelled(summary, "الإجمالي (بدون ضريبة)")),
    taxAmount: money(labelled(summary, "ضريبة القيمة المضافة")),
    total: money(labelled(summary, "الإجمالي شامل الضريبة")),
    summaryLines,
    orders: parseOrders(sheetRows(workbook, ORDERS_SHEET)),
    storage: parseStorage(sheetRows(workbook, STORAGE_SHEET)),
  };
}

function headerIndex(header: Row): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((cell, i) => {
    const name = text(cell);
    if (name) map.set(name, i);
  });
  return map;
}

function parseOrders(rows: Row[]): InvoiceOrderLine[] {
  if (rows.length < 2) return [];
  const col = headerIndex(rows[0]);
  const at = (row: Row, name: string) => {
    const i = col.get(name);
    return i === undefined ? null : row[i] ?? null;
  };

  const orders: InvoiceOrderLine[] = [];
  for (const row of rows.slice(1)) {
    const ref = text(at(row, "رقم الطلب"));
    // The sheet ends with a TOTALS row that carries no order number; it is a
    // restatement of the rows above, and adding it would double the invoice.
    if (!ref || ref.toUpperCase() === "TOTALS" || ref.startsWith("الإجمالي")) continue;

    const delivered = text(at(row, "تاريخ التوصيل"));
    const deliveredAt = delivered ? new Date(delivered) : null;

    orders.push({
      externalOrderRef: ref,
      shipmentRef: text(at(row, "رقم الشحنة")) || null,
      carrier: text(at(row, "شركة الشحن")) || null,
      deliveredAt: deliveredAt && !Number.isNaN(deliveredAt.getTime()) ? deliveredAt : null,
      // "Pets-large-005 (5 KG)\nbowl-small-017 (0.5 KG)" — one per line, each
      // with its weight in brackets.
      skus: text(at(row, "أكواد المنتجات (الوزن)"))
        .split(/\r?\n/)
        .map((s) => s.replace(/\s*\(.*?\)\s*$/, "").trim())
        .filter(Boolean),
      totalPieces: count(at(row, "إجمالي القطع")),
      includedPieces: count(at(row, "القطع المشمولة")),
      extraPieces: count(at(row, "القطع الإضافية")),
      weightKg: toQty(count(at(row, "وزن الشحنة (كجم)"))),
      packagingFee: money(at(row, "رسوم التغليف")),
      handlingFee: money(at(row, "رسوم تجهيز الطلب")),
      shippingFee: money(at(row, "إجمالي رسوم الشحن")),
      extraPieceFee: money(at(row, "رسوم القطع الإضافية")),
      totalBeforeTax: money(at(row, "تكلفة الطلب (بدون ضريبة)")),
      taxAmount: money(at(row, "ضريبة 15%")),
    });
  }
  return orders;
}

function parseStorage(rows: Row[]): InvoiceSimpleLine[] {
  if (rows.length < 2) return [];
  const col = headerIndex(rows[0]);
  const at = (row: Row, name: string) => {
    const i = col.get(name);
    return i === undefined ? null : row[i] ?? null;
  };

  const lines: InvoiceSimpleLine[] = [];
  for (const row of rows.slice(1)) {
    const client = text(row[0]);
    if (!client || client.startsWith("الإجمالي")) continue; // totals row
    const pallets = count(at(row, "عدد الطبالي"));
    const total = money(at(row, "الإجمالي"));
    if (pallets === 0 && total === 0) continue;
    lines.push({
      description: `تخزين — ${text(at(row, "المستودع")) || "المستودع"}`,
      quantity: toQty(pallets),
      amount: total,
    });
  }
  return lines;
}

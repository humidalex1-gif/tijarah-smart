/**
 * Sorting the two files Fast Hub sends, and recovering the invoice number.
 *
 * Their bill arrives as a pair: a workbook with a row per order, and a PDF
 * that is the invoice document proper. The workbook is the data — it parses
 * exactly, where a PDF is read by guesswork — but the invoice NUMBER is not in
 * it. Its summary sheet carries العميل, التاريخ and عدد الشحنات, and stops.
 *
 * Nor is the number recoverable from the PDF's text layer. That file stores
 * text as hex glyph indices against a subset font whose ToUnicode map is wrong
 * by a constant offset: real digits decode to `6 7 8 9 : ;` and Arabic to
 * isolated presentation forms (ﺤ ﺥ ﺦ ﺧ). It is the same defect that renders
 * `إيصال التحويل` as `إٮ,صال ال%ٮحويل` in the receipt from the same batch.
 *
 * So the number is read from the FILENAME, where it sits in plain text, and
 * shown for confirmation rather than trusted. That asymmetry is the whole
 * design: the number is the duplicate guard in `postWarehouseInvoice`, so a
 * wrong one lets the same invoice post twice under two numbers and charge
 * every order a second time. A wrong suggestion is visible and costs a
 * keystroke; a wrong extraction would be silent.
 */

/** Anything with a name — a browser `File`, or a plain object in a test. */
export type NamedFile = { name: string };

export type InvoiceFileProblem = "NO_WORKBOOK" | "TOO_MANY_WORKBOOKS" | "UNSUPPORTED_FILE";

export type ClassifiedInvoiceFiles<T extends NamedFile> = {
  workbook: T | null;
  document: T | null;
  problem: InvoiceFileProblem | null;
};

const WORKBOOK = /\.(xlsx|xlsm|xls)$/i;
const DOCUMENT = /\.pdf$/i;

/**
 * The number must be ANNOUNCED by a marker — رقم, No, or # — never merely
 * present. Fast Hub names the workbook `Invoice_Sokudry_2026-08-02`, and a
 * rule that took the first digits it found would seed the duplicate guard with
 * `2026`, colliding August's invoice with every other invoice of the year.
 */
const NUMBER = /(?:رقم|#|\bno\.?)\s*[:._-]?\s*(\d{1,10})/i;

export function invoiceNumberFromFileName(fileName: string): string | null {
  if (!fileName) return null;
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return withoutExtension.match(NUMBER)?.[1] ?? null;
}

export function classifyInvoiceFiles<T extends NamedFile>(files: T[]): ClassifiedInvoiceFiles<T> {
  const workbooks = files.filter((f) => WORKBOOK.test(f.name));
  const documents = files.filter((f) => DOCUMENT.test(f.name));
  const unplaceable = files.filter((f) => !WORKBOOK.test(f.name) && !DOCUMENT.test(f.name));

  // Ambiguity refuses rather than picks. Parsing "one of the two workbooks"
  // would post a month's fees from whichever file sorted first.
  if (workbooks.length > 1) return { workbook: null, document: null, problem: "TOO_MANY_WORKBOOKS" };
  if (workbooks.length === 0) return { workbook: null, document: null, problem: "NO_WORKBOOK" };

  return {
    workbook: workbooks[0],
    document: documents[0] ?? null,
    problem: unplaceable.length > 0 ? "UNSUPPORTED_FILE" : null,
  };
}

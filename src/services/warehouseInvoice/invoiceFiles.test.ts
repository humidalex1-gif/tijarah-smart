import { describe, it, expect } from "vitest";
import {
  invoiceNumberFromFileName,
  classifyInvoiceFiles,
} from "@/services/warehouseInvoice/invoiceFiles";

/**
 * Fast Hub's invoice number lives in exactly one place: the PDF. Not in the
 * workbook — its summary sheet carries العميل, التاريخ and عدد الشحنات and
 * nothing else — and not recoverably in the PDF's text layer either, whose
 * ToUnicode map decodes real digits to `6 7 8 9 : ;` and Arabic to isolated
 * presentation forms. Reverse-engineering that offset to obtain the number
 * would be brittle, and the number is the duplicate guard: get it wrong and
 * the same invoice posts twice under two numbers, charging every order again.
 *
 * The filename carries it in plain text. So it is read from there and shown
 * for confirmation — a wrong suggestion is visible and costs a keystroke,
 * where a wrong extraction would be silent.
 */

describe("invoiceNumberFromFileName", () => {
  it("reads the number out of Fast Hub's own Arabic filename", () => {
    // The real file, byte for byte as it arrives in Downloads.
    expect(invoiceNumberFromFileName("متجر سوكودراي-فاتورة رقم 211-يوليو.pdf")).toBe("211");
  });

  it("reads an English invoice number", () => {
    expect(invoiceNumberFromFileName("Sokudry Invoice No. 211.pdf")).toBe("211");
  });

  it("reads a hash-marked number", () => {
    expect(invoiceNumberFromFileName("invoice #4102.pdf")).toBe("4102");
  });

  it("returns null rather than mistaking a date for an invoice number", () => {
    // This one matters most: the workbook is named by DATE, and seeding the
    // duplicate guard with `2026` would let August's invoice collide with
    // every other invoice of the year.
    expect(invoiceNumberFromFileName("Invoice_Sokudry_2026-08-02.xlsx")).toBeNull();
  });

  it("returns null when there is no number at all", () => {
    expect(invoiceNumberFromFileName("scan.pdf")).toBeNull();
  });

  it("returns null for an empty name", () => {
    expect(invoiceNumberFromFileName("")).toBeNull();
  });
});

describe("classifyInvoiceFiles", () => {
  const file = (name: string) => ({ name });

  it("splits the workbook from the document", () => {
    const result = classifyInvoiceFiles([
      file("متجر سوكودراي-فاتورة رقم 211-يوليو.pdf"),
      file("Invoice_Sokudry_2026-08-02.xlsx"),
    ]);

    expect(result.workbook?.name).toBe("Invoice_Sokudry_2026-08-02.xlsx");
    expect(result.document?.name).toBe("متجر سوكودراي-فاتورة رقم 211-يوليو.pdf");
  });

  it("accepts the workbook alone, leaving the document empty", () => {
    const result = classifyInvoiceFiles([file("Invoice_Sokudry_2026-08-02.xlsx")]);

    expect(result.workbook?.name).toBe("Invoice_Sokudry_2026-08-02.xlsx");
    expect(result.document).toBeNull();
  });

  it("refuses two workbooks rather than silently parsing one of them", () => {
    const result = classifyInvoiceFiles([file("july.xlsx"), file("august.xlsx")]);

    expect(result.workbook).toBeNull();
    expect(result.problem).toBe("TOO_MANY_WORKBOOKS");
  });

  it("reports a missing workbook when only the PDF is given", () => {
    const result = classifyInvoiceFiles([file("فاتورة رقم 211.pdf")]);

    expect(result.workbook).toBeNull();
    expect(result.problem).toBe("NO_WORKBOOK");
  });

  it("names a file it cannot place instead of ignoring it", () => {
    const result = classifyInvoiceFiles([file("Invoice.xlsx"), file("notes.txt")]);

    expect(result.workbook?.name).toBe("Invoice.xlsx");
    expect(result.problem).toBe("UNSUPPORTED_FILE");
  });
});

import { describe, it, expect } from "vitest";
import { toCsv, CSV_BOM } from "./csv";

/**
 * The CSV the export routes hand to Excel.
 *
 * Two facts drive every test here: RFC 4180 is exact about quoting, and
 * Excel on Windows decides the encoding of a .csv by sniffing — without a
 * UTF-8 BOM it falls back to the ANSI code page and renders every Arabic
 * name as mojibake. That failure looks like OUR data is corrupt.
 */
describe("toCsv", () => {
  it("joins headers and rows with CRLF, as RFC 4180 says", () => {
    const csv = toCsv(["a", "b"], [["1", "2"], ["3", "4"]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(["x"], [["1,5"]])).toBe('x\r\n"1,5"');
  });

  it("quotes and doubles a field containing a quote", () => {
    expect(toCsv(["x"], [['he said "no"']])).toBe('x\r\n"he said ""no"""');
  });

  it("quotes a field containing a newline instead of breaking the row", () => {
    expect(toCsv(["x"], [["line1\nline2"]])).toBe('x\r\n"line1\nline2"');
  });

  it("writes numbers plainly, in ASCII digits, for Excel to sum", () => {
    // Localized digits here would defeat the point of the export: ٢٥٩ is a
    // STRING to a spreadsheet, and a column of strings does not total.
    expect(toCsv(["n"], [[259.5]])).toBe("n\r\n259.5");
  });

  it("writes an empty cell for null and undefined, never the word", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,");
  });

  it("exports Arabic text intact", () => {
    expect(toCsv(["الاسم"], [["وعاء كبير"]])).toBe("الاسم\r\nوعاء كبير");
  });

  it("ships the BOM Excel needs to read that Arabic as UTF-8", () => {
    expect(CSV_BOM).toBe("\uFEFF");
  });

  it("neutralises cells Excel would execute as formulas", () => {
    // Customer names and expense descriptions are free text authored by any
    // role holding customers.create. '=WEBSERVICE(...)' as a name would run
    // under the accountant's Excel profile the moment the export opens --
    // the exact file this module exists to produce. OWASP's fix: lead the
    // cell with an apostrophe so Excel reads it as text.
    expect(toCsv(["x"], [["=WEBSERVICE(1)"]])).toBe("x\r\n'=WEBSERVICE(1)");
    expect(toCsv(["x"], [["+1+2"]])).toBe("x\r\n'+1+2");
    expect(toCsv(["x"], [["-cmd"]])).toBe("x\r\n'-cmd");
    expect(toCsv(["x"], [["@SUM(A1)"]])).toBe("x\r\n'@SUM(A1)");
  });

  it("leaves negative NUMBERS alone -- they are figures, not formulas", () => {
    // The guard is for authored text; a numeric -16 fee must stay a number
    // Excel can sum, or the export defeats its own purpose.
    expect(toCsv(["n"], [[-16]])).toBe("n\r\n-16");
  });
});

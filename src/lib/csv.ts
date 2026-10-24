/**
 * CSV building for the export routes, and nothing else.
 *
 * RFC 4180: CRLF between records; a field containing a comma, a quote or a
 * newline is wrapped in quotes with inner quotes doubled. Numbers are written
 * in plain ASCII — a localized ٢٥٩ is a string to a spreadsheet, and a column
 * of strings does not total.
 */
export type CsvCell = string | number | null | undefined;

/**
 * Excel on Windows sniffs a .csv's encoding and, finding no BOM, falls back
 * to the ANSI code page — which renders every Arabic product name as
 * mojibake that looks like corrupt data. The routes prepend this.
 */
export const CSV_BOM = "\uFEFF";

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  // Numbers are exempt from the formula guard below: -16 is a figure Excel
  // must sum, not an attack — and a number cannot carry a payload.
  if (typeof value === "number") return String(value);
  let text = value;
  // Excel executes a cell starting with = + - or @ as a formula. These
  // fields carry free text authored by whoever can name a customer or
  // describe an expense, and this file exists to be opened in Excel — so a
  // leading trigger is neutralised with an apostrophe (OWASP), which Excel
  // shows as plain text.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

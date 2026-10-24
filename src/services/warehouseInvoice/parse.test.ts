import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { toMinor, toQty } from "@/lib/money";
import { parseFastHubInvoice } from "@/services/warehouseInvoice/parse";

/**
 * Parsed against the REAL workbook Fast Hub sent on 2026-08-02, kept at
 * `tests/fixtures-invoice.xlsx`. A synthetic fixture would only prove the
 * parser reads a spreadsheet I wrote; this proves it reads theirs.
 *
 * Two things in that file drive most of the code: the money arrives as
 * binary-float noise (`14.000000000000002`, `54.998999999999995`) and must
 * land on exact minor units, and the per-order sheet is the only place the
 * fees are broken down — the PDF carries the summary alone.
 */

const workbook = () => readFileSync("tests/fixtures-invoice.xlsx");

describe("parseFastHubInvoice", () => {
  it("reads the header off the summary sheet", async () => {
    const invoice = await parseFastHubInvoice(workbook());

    expect(invoice.invoiceDate.toISOString().slice(0, 10)).toBe("2026-08-02");
    expect(invoice.shipmentCount).toBe(7);
    expect(invoice.subtotal).toBe(toMinor(335.5));
    expect(invoice.taxAmount).toBe(toMinor(50.33));
    expect(invoice.total).toBe(toMinor(385.83));
  });

  it("breaks the per-order fees out by order, which the PDF never shows", async () => {
    const invoice = await parseFastHubInvoice(workbook());

    expect(invoice.orders).toHaveLength(7);
    const one = invoice.orders.find((o) => o.externalOrderRef === "111462246");
    expect(one).toBeDefined();
    // The heaviest order on the invoice: 6 pieces, 2 included, 4 extra.
    expect(one!.packagingFee).toBe(toMinor(2));
    expect(one!.handlingFee).toBe(toMinor(4));
    expect(one!.shippingFee).toBe(toMinor(10));
    expect(one!.extraPieceFee).toBe(toMinor(2));
    expect(one!.totalBeforeTax).toBe(toMinor(18));
    expect(one!.totalPieces).toBe(6);
    expect(one!.includedPieces).toBe(2);
    expect(one!.extraPieces).toBe(4);
    expect(one!.weightKg).toBe(toQty(12));
    expect(one!.skus).toEqual(["Pets-large-005", "bowl-small-017", "bowl-large-016"]);
  });

  it("stops the fee table at the blank row, not at the bank details below it", async () => {
    // The summary sheet ends with the warehouse's own bank account. Scanning
    // past the table added "البنك / بنك الراجحي" as a zero fee — junk that
    // would still have printed on the confirmation screen as postable.
    const invoice = await parseFastHubInvoice(workbook());

    expect(invoice.summaryLines).toHaveLength(5);
    expect(invoice.summaryLines.some((l) => l.description.includes("البنك"))).toBe(false);
    expect(invoice.summaryLines.some((l) => l.description.includes("آيبان"))).toBe(false);
  });

  it("rounds the workbook's float noise onto exact minor units", async () => {
    const invoice = await parseFastHubInvoice(workbook());

    // 14.000000000000002 in the file.
    const packaging = invoice.summaryLines.find((l) => l.description.includes("التغليف"));
    expect(packaging!.amount).toBe(toMinor(14));
    // 54.998999999999995 per pallet x 4 = 219.99599999999998.
    expect(invoice.storage.reduce((s, l) => s + l.amount, 0)).toBe(toMinor(220));
  });

  it("reads storage separately, because it belongs to no order", async () => {
    const invoice = await parseFastHubInvoice(workbook());

    expect(invoice.storage).toHaveLength(1);
    expect(invoice.storage[0].quantity).toBe(toQty(4));
    expect(invoice.storage[0].amount).toBe(toMinor(220));
  });

  it("refuses a file that is not a Fast Hub invoice, instead of half-reading it", async () => {
    // A spreadsheet without the summary sheet must fail loudly. Returning an
    // empty invoice would post nothing and look like a successful upload.
    await expect(parseFastHubInvoice(Buffer.from("not a workbook")))
      .rejects.toThrow();
  });
});

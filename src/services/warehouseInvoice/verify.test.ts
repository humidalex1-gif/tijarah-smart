import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import { parseFastHubInvoice } from "@/services/warehouseInvoice/parse";
import { verifyWarehouseInvoice } from "@/services/warehouseInvoice/verify";
import { makeCompany, makeWarehouse, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The invoice is an ASSERTION by the warehouse, not a fact. This project
 * exists because that distinction matters: the same warehouse whose stock
 * count is checked against the books gets its bill checked too.
 *
 * Run against the real 2026-08-02 workbook.
 */

const workbook = () => readFileSync("tests/fixtures-invoice.xlsx");

/** The seven order numbers Fast Hub billed on that invoice. */
const BILLED = [
  "551614928", "1360405922", "1699811234",
  "605050236", "1063315702", "141085494", "111462246",
];

async function seedOrders(companyId: string, warehouseId: string, refs: string[]) {
  for (const [i, ref] of refs.entries()) {
    await prisma.salesOrder.create({
      data: {
        companyId,
        warehouseId,
        salesOrderNumber: `SO-${String(i + 1).padStart(4, "0")}`,
        channel: "FASTHUB",
        status: "CONFIRMED",
        orderDate: new Date("2026-07-20T00:00:00Z"),
        externalSource: "FASTHUB",
        externalRef: ref,
        externalKey: `FASTHUB:${ref}`,
      },
    });
  }
}

async function setup(refs: string[] = BILLED) {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  await seedOrders(company.id, warehouse.id, refs);
  return { company, ctx: makeCtx(company.id) };
}

describe("verifyWarehouseInvoice", () => {
  beforeEach(resetDb);

  it("matches every billed order to the books when they agree", async () => {
    const { ctx } = await setup();
    const parsed = await parseFastHubInvoice(workbook());

    const result = await verifyWarehouseInvoice(ctx, parsed);

    expect(result.orders).toHaveLength(7);
    expect(result.orders.every((o) => o.salesOrderId !== null)).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("names an order they billed that the books do not have", async () => {
    // This is the check that would have caught the 24 orders missing from the
    // books: the warehouse charged for work on an order we never imported.
    const { ctx } = await setup(BILLED.filter((r) => r !== "111462246"));
    const parsed = await parseFastHubInvoice(workbook());

    const result = await verifyWarehouseInvoice(ctx, parsed);

    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: "ORDER_NOT_IN_BOOKS", ref: "111462246" }),
    );
    const orphan = result.orders.find((o) => o.line.externalOrderRef === "111462246");
    expect(orphan!.salesOrderId).toBeNull();
  });

  it("refuses to match an order the books still hold as a draft", async () => {
    // A shipped-but-still-DRAFT order (production has these) used to match by
    // externalRef alone; posting then threw AFTER the invoice committed and
    // left it half-posted with the duplicate guard blocking every retry.
    const { ctx } = await setup(BILLED.filter((r) => r !== "111462246"));
    await prisma.salesOrder.create({
      data: {
        companyId: ctx.companyId,
        salesOrderNumber: "SO-DRAFT",
        status: "DRAFT",
        warehouseId: (await prisma.warehouse.findFirstOrThrow()).id,
        externalSource: "FASTHUB", externalRef: "111462246", externalKey: "FASTHUB:111462246",
        orderDate: new Date("2026-07-20T00:00:00Z"),
      },
    });

    const result = await verifyWarehouseInvoice(ctx, await parseFastHubInvoice(workbook()));

    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: "ORDER_NOT_CONFIRMED", ref: "111462246" }),
    );
    const row = result.orders.find((o) => o.line.externalOrderRef === "111462246");
    expect(row!.salesOrderId).toBeNull();
  });

  it("re-computes their extra-piece arithmetic instead of trusting it", async () => {
    const { ctx } = await setup();
    const parsed = await parseFastHubInvoice(workbook());
    // They billed 4 extra pieces on this order: 6 total, 2 included. Claim 6.
    const line = parsed.orders.find((o) => o.externalOrderRef === "111462246")!;
    line.extraPieces = 6;

    const result = await verifyWarehouseInvoice(ctx, parsed);

    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: "EXTRA_PIECES_WRONG", ref: "111462246" }),
    );
  });

  it("adds up their own fee columns and objects when the order total does not follow", async () => {
    const { ctx } = await setup();
    const parsed = await parseFastHubInvoice(workbook());
    parsed.orders[0].totalBeforeTax += toMinor(5);

    const result = await verifyWarehouseInvoice(ctx, parsed);

    expect(result.issues.some((i) => i.kind === "ORDER_FEES_DO_NOT_ADD_UP")).toBe(true);
  });

  it("checks the invoice subtotal against the lines it is made of", async () => {
    const { ctx } = await setup();
    const parsed = await parseFastHubInvoice(workbook());
    parsed.subtotal += toMinor(100);

    const result = await verifyWarehouseInvoice(ctx, parsed);

    expect(result.issues.some((i) => i.kind === "SUBTOTAL_DOES_NOT_MATCH_LINES")).toBe(true);
  });

  it("reports an order in the books that they did not bill", async () => {
    // Not an error — it may ship on next month's invoice — but the merchant
    // should know a delivered order went unbilled rather than discover it in
    // three months' time.
    const { ctx } = await setup([...BILLED, "999888777"]);
    const parsed = await parseFastHubInvoice(workbook());

    const result = await verifyWarehouseInvoice(ctx, parsed);

    expect(result.unbilled.map((o) => o.externalRef)).toEqual(["999888777"]);
  });

  it("totals the fees per destination, keeping storage out of the order costs", async () => {
    const { ctx } = await setup();
    const parsed = await parseFastHubInvoice(workbook());

    const result = await verifyWarehouseInvoice(ctx, parsed);

    // 115.50 of per-order fees, 220.00 of storage, 335.50 together.
    expect(result.totals.orderFees).toBe(toMinor(115.5));
    expect(result.totals.storage).toBe(toMinor(220));
    expect(result.totals.orderFees + result.totals.storage).toBe(parsed.subtotal);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { importFastHubOpeningStock } from "@/services/fasthub/inventory";
import { applyOpeningCorrection } from "@/services/fasthub/opening-correction";
import { createSalesOrder, confirmSale, cancelSale } from "@/services/sales";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The repair for the defect that shipped on 2026-08-04: the opening balances
 * were taken from Fast Hub's counts, which are net of every shipment already
 * made, and then the historical orders were imported on top and deducted the
 * same units a second time. 29 units across 8 SKUs sat on the shelf while the
 * books said they were gone.
 *
 * The correction is not a reset. The books never recorded RECEIVING those
 * units, though they were bought, held and sold — so the honest fix is an
 * opening receipt dated before the first order, which is what the opening
 * balance should have been all along.
 */

async function soldBefore(
  companyId: string,
  warehouseId: string,
  productId: string,
  orderDate: Date,
  quantity: number,
) {
  const { salesOrderId } = await createSalesOrder({ companyId, userId: null }, {
    warehouseId,
    channel: "FASTHUB",
    orderDate,
    items: [{ productId, quantity, unitPrice: toMinor(260) }],
  });
  await confirmSale({ companyId, userId: null }, { salesOrderId });
  return salesOrderId;
}

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id, "flodable-dish-020");
  // The opening import runs NOW, exactly as it did in production: Fast Hub's
  // count of what is on the shelf today.
  await importFastHubOpeningStock(ctx, {
    warehouseId: warehouse.id,
    counts: [{ sku: "flodable-dish-020", available: toQty(18), damaged: 0, unitCost: toCost(toMinor(71.78)) }],
  });
  return { company, warehouse, ctx, product };
}

describe("applyOpeningCorrection", () => {
  beforeEach(resetDb);

  it("adds back the units sold before the opening balance was taken", async () => {
    const { company, warehouse, ctx, product } = await setup();
    await soldBefore(company.id, warehouse.id, product.id, new Date("2026-06-03T00:00:00Z"), toQty(5));

    const before = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(before.availableQty).toBe(toQty(13));

    const report = await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].sku).toBe("flodable-dish-020");
    expect(report.lines[0].quantity).toBe(toQty(5));

    const after = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(after.availableQty).toBe(toQty(18));
    // Added at the opening import's own cost, so the average is untouched.
    expect(after.avgCost).toBe(before.avgCost);
  });

  it("leaves a sale made after the opening balance alone", async () => {
    // The other half. A correction that fires on every sale would re-inflate
    // the shelf forever and hide every real loss the project exists to find.
    const { company, warehouse, ctx, product } = await setup();
    await soldBefore(company.id, warehouse.id, product.id, new Date(Date.now() + 60_000), toQty(4));

    const report = await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });

    expect(report.lines).toEqual([]);
    const after = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(after.availableQty).toBe(toQty(14));
  });

  it("corrects nothing on a second run, because the correction outdates the orders", async () => {
    const { company, warehouse, ctx, product } = await setup();
    await soldBefore(company.id, warehouse.id, product.id, new Date("2026-06-03T00:00:00Z"), toQty(5));

    await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });
    const second = await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });

    expect(second.lines).toEqual([]);
    const after = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(after.availableQty).toBe(toQty(18));
  });

  it("ignores a pre-opening order that was cancelled, whose units already came back", async () => {
    // A cancellation puts the units back. Counting the sale and ignoring its
    // reversal would add them a SECOND time — the very error being repaired,
    // committed by the repair itself.
    const { company, warehouse, ctx, product } = await setup();
    const salesOrderId = await soldBefore(
      company.id, warehouse.id, product.id, new Date("2026-06-03T00:00:00Z"), toQty(5),
    );
    await cancelSale({ companyId: company.id, userId: null }, {
      salesOrderId, reason: "Customer changed their mind",
    });

    const report = await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });

    expect(report.lines).toEqual([]);
    const after = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(after.availableQty).toBe(toQty(18));
  });

  it("dates the correction before the earliest order, which is what moves the poller's boundary", async () => {
    // The guard in syncFastHubOrders reads the EARLIEST FASTHUB_IMPORT
    // movement per product. If the correction were stamped with today's date
    // the boundary would not move, the books would be right and the sync would
    // still refuse every order it had already accounted for.
    const { company, warehouse, ctx, product } = await setup();
    await soldBefore(company.id, warehouse.id, product.id, new Date("2026-06-03T00:00:00Z"), toQty(5));

    const report = await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });

    expect(report.lines[0].asOf.toISOString()).toBe("2026-06-02T00:00:00.000Z");
    const earliest = await prisma.inventoryMovement.findFirstOrThrow({
      where: { productId: product.id, referenceType: "FASTHUB_IMPORT" },
      orderBy: { movementDate: "asc" },
    });
    expect(earliest.movementDate.toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });
});

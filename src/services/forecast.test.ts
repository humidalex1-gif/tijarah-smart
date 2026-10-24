import { describe, it, expect, beforeEach } from "vitest";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual } from "@/services/stock";
import { createSalesOrder, confirmSale, cancelSale } from "@/services/sales";
import { stockoutForecast } from "@/services/forecast";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../tests/factories";

/**
 * "Low stock" compares a balance to a number the owner typed once per product.
 * This compares it to how fast the product actually leaves the shelf, which is
 * the difference between a report and a decision: not "rainy-light is low" but
 * "rainy-light runs out in twelve days, order eighty".
 */
const now = new Date("2026-09-11T09:00:00.000Z");

async function shop() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  return { company, warehouse, ctx };
}

async function stock(ctx: ReturnType<typeof makeCtx>, warehouseId: string, productId: string, units: number) {
  await receiveStockManual(ctx, {
    warehouseId, productId, quantity: toQty(units), unitCost: toCost(toMinor(10)),
  });
}

async function sell(ctx: ReturnType<typeof makeCtx>, warehouseId: string, productId: string, units: number) {
  const { salesOrderId } = await createSalesOrder(ctx, {
    warehouseId,
    orderDate: now,
    items: [{ productId, quantity: toQty(units), unitPrice: toMinor(50) }],
  });
  await confirmSale(ctx, { salesOrderId, paidAmount: 0 });
  return salesOrderId;
}

describe("stockoutForecast", () => {
  beforeEach(resetDb);

  it("measures how fast each product sells and how long what is left will last", async () => {
    const { company, warehouse, ctx } = await shop();
    const steady = await makeProduct(company.id, "steady");
    const urgent = await makeProduct(company.id, "urgent");
    await stock(ctx, warehouse.id, steady.id, 30);
    await stock(ctx, warehouse.id, urgent.id, 22);
    await sell(ctx, warehouse.id, steady.id, 5);
    await sell(ctx, warehouse.id, steady.id, 5);
    await sell(ctx, warehouse.id, urgent.id, 20);

    const rows = await stockoutForecast(company.id, { now, windowDays: 30, coverDays: 30 });

    // Soonest to run out first: that is the order the owner acts in.
    expect(rows.map((r) => r.sku)).toEqual(["urgent", "steady"]);

    const [u, s] = rows;
    // 20 sold in 30 days, 2 left: three days of cover, and eighteen more units
    // to cover the next thirty.
    expect(u.availableQty).toBe(toQty(2));
    expect(u.soldInWindow).toBe(toQty(20));
    expect(u.daysOfCover).toBeCloseTo(3, 5);
    expect(u.suggestedQty).toBe(toQty(18));
    // 10 sold in 30 days, 20 left: sixty days, nothing to order.
    expect(s.availableQty).toBe(toQty(20));
    expect(s.daysOfCover).toBeCloseTo(60, 5);
    expect(s.suggestedQty).toBe(0);
  });

  it("does not count a cancelled sale as demand", async () => {
    // The cancellation puts the units back; a forecast that only reads the
    // way out would order stock for a sale that never happened.
    const { company, warehouse, ctx } = await shop();
    const product = await makeProduct(company.id, "cancelled");
    await stock(ctx, warehouse.id, product.id, 10);
    const orderId = await sell(ctx, warehouse.id, product.id, 5);
    await cancelSale(ctx, { salesOrderId: orderId, reason: "Test" });

    const rows = await stockoutForecast(company.id, { now, windowDays: 30, coverDays: 30 });
    expect(rows.find((r) => r.sku === "cancelled")).toBeUndefined();
  });

  it("leaves out a product that has not sold in the window", async () => {
    // No velocity means no forecast, not an infinite one. A product that has
    // never sold is a catalogue question, not a reorder question.
    const { company, warehouse, ctx } = await shop();
    const product = await makeProduct(company.id, "idle");
    await stock(ctx, warehouse.id, product.id, 10);

    const rows = await stockoutForecast(company.id, { now, windowDays: 30, coverDays: 30 });
    expect(rows).toEqual([]);
  });
});

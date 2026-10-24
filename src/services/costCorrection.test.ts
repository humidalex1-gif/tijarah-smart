import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor, costOf } from "@/lib/money";
import { importFastHubOpeningStock } from "@/services/fasthub/inventory";
import { planCostCorrection, applyCostCorrection } from "@/services/costCorrection";
import { createSalesOrder, confirmSale } from "@/services/sales";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../tests/factories";

/**
 * The repair for the products the costing sheet never priced. The opening
 * import books everything at cost 0, so six products landed at `avgCost` 0 and
 * a weighted average has nowhere to move from. Three of them sold, and those
 * four orders report gross profit equal to revenue — 45.4% of all revenue at
 * 100% margin.
 *
 * Two halves, deliberately separate: the stock still on the shelf is revalued
 * through an ADJUSTMENT_OUT/IN pair, and the units already sold are corrected
 * on the ORDER, because they are not on the shelf to reprice.
 */

const LANDED = toCost(toMinor(85.45));

async function setup(opening = 93, sku = "Pets-large-005") {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id, sku);
  // Exactly as production did it: Fast Hub's count, imported at cost 0.
  await importFastHubOpeningStock(ctx, {
    warehouseId: warehouse.id,
    counts: [{ sku, available: toQty(opening), damaged: 0, unitCost: 0 }],
  });
  return { company, warehouse, ctx, product };
}

async function sell(ctx: ReturnType<typeof makeCtx>, warehouseId: string, productId: string, units: number) {
  const { salesOrderId } = await createSalesOrder(ctx, {
    warehouseId,
    channel: "FASTHUB",
    orderDate: new Date("2026-07-20T00:00:00Z"),
    items: [{ productId, quantity: toQty(units), unitPrice: toMinor(199) }],
  });
  await confirmSale(ctx, { salesOrderId });
  return salesOrderId;
}

const costs = [{ sku: "Pets-large-005", unitCost: LANDED }];

describe("applyCostCorrection", () => {
  beforeEach(resetDb);

  it("moves the average onto the true cost without moving the quantity", async () => {
    const { warehouse, ctx, product } = await setup();

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(balance.avgCost).toBe(LANDED);
    // The pair nets to nothing. A revaluation that changed the shelf would be
    // a stock adjustment wearing a costing label.
    expect(balance.availableQty).toBe(toQty(93));
  });

  it("restates the cost and gross profit of an order that already sold at zero", async () => {
    const { warehouse, ctx, product } = await setup();
    const salesOrderId = await sell(ctx, warehouse.id, product.id, 2);

    const before = await prisma.salesOrder.findFirstOrThrow({ where: { id: salesOrderId } });
    expect(before.totalCost).toBe(0);
    expect(before.grossProfit).toBe(toMinor(398));

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId } });
    expect(item.unitCostSnapshot).toBe(LANDED);
    expect(item.totalCost).toBe(costOf(toQty(2), LANDED));
    expect(item.grossProfit).toBe(item.lineTotal - item.totalCost);

    const order = await prisma.salesOrder.findFirstOrThrow({ where: { id: salesOrderId } });
    expect(order.totalCost).toBe(item.totalCost);
    expect(order.grossProfit).toBe(item.grossProfit);
  });

  it("revalues only the units still on the shelf, leaving the sold ones to the order", async () => {
    const { warehouse, ctx, product } = await setup();
    await sell(ctx, warehouse.id, product.id, 5);

    const report = await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(balance.availableQty).toBe(toQty(88));
    expect(balance.avgCost).toBe(LANDED);
    expect(report.lines[0].revaluedQty).toBe(toQty(88));
    expect(report.lines[0].restatedOrders).toHaveLength(1);
  });

  it("recomputes net profit through the allocation, not just gross", async () => {
    const { warehouse, ctx, product } = await setup();
    const salesOrderId = await sell(ctx, warehouse.id, product.id, 2);

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId } });
    // No order-level costs exist here, so net must equal gross — but it must
    // have been RECOMPUTED to get there, not left at its confirmation value.
    expect(item.netProfit).toBe(item.grossProfit);
  });

  it("writes the revaluation under its own reference type, never FASTHUB_IMPORT", async () => {
    const { warehouse, ctx, product } = await setup();

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const movements = await prisma.inventoryMovement.findMany({
      where: { productId: product.id, referenceType: "COST_REVALUATION" },
      orderBy: { direction: "asc" },
    });
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.direction).sort()).toEqual(["IN", "OUT"]);
    expect(movements.every((m) => m.quantity === toQty(93))).toBe(true);

    // Reusing FASTHUB_IMPORT would move the pre-opening boundary that
    // syncFastHubOrders derives, and feed planOpeningCorrection a revaluation
    // as though it were an opening receipt.
    const openings = await prisma.inventoryMovement.count({
      where: { productId: product.id, referenceType: "FASTHUB_IMPORT" },
    });
    expect(openings).toBe(1);
  });

  it("is a no-op the second time, so a re-run cannot double the cost", async () => {
    const { warehouse, ctx, product } = await setup();
    await sell(ctx, warehouse.id, product.id, 2);
    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const balanceAfterFirst = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    const orderAfterFirst = await prisma.salesOrder.findFirstOrThrow({ where: { companyId: ctx.companyId } });

    const second = await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    expect(second.lines).toHaveLength(0);
    expect(second.skipped.map((s) => s.sku)).toContain("Pets-large-005");
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(balance.avgCost).toBe(balanceAfterFirst.avgCost);
    expect(balance.availableQty).toBe(balanceAfterFirst.availableQty);
    const order = await prisma.salesOrder.findFirstOrThrow({ where: { companyId: ctx.companyId } });
    expect(order.totalCost).toBe(orderAfterFirst.totalCost);
    expect(order.grossProfit).toBe(orderAfterFirst.grossProfit);
  });

  /**
   * The guard above is `avgCost != 0`, which a product with no stock never
   * trips — the pair is skipped, so the average stays 0 forever. Idempotency
   * there rests entirely on the order filter, and this is the test that pins it.
   */
  it("restates a sold-out product's orders and re-runs safely without any stock to revalue", async () => {
    const { warehouse, ctx, product } = await setup(5);
    const salesOrderId = await sell(ctx, warehouse.id, product.id, 5);

    const first = await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });
    expect(first.lines[0].revaluedQty).toBe(0);
    expect(await prisma.inventoryMovement.count({
      where: { productId: product.id, referenceType: "COST_REVALUATION" },
    })).toBe(0);

    const afterFirst = await prisma.salesOrder.findFirstOrThrow({ where: { id: salesOrderId } });
    expect(afterFirst.totalCost).toBe(costOf(toQty(5), LANDED));

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const afterSecond = await prisma.salesOrder.findFirstOrThrow({ where: { id: salesOrderId } });
    expect(afterSecond.totalCost).toBe(afterFirst.totalCost);
    expect(afterSecond.grossProfit).toBe(afterFirst.grossProfit);
  });

  it("leaves a draft order alone", async () => {
    const { warehouse, ctx, product } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      channel: "FASTHUB",
      orderDate: new Date("2026-08-02T00:00:00Z"),
      items: [{ productId: product.id, quantity: toQty(2), unitPrice: toMinor(199) }],
    });

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const draft = await prisma.salesOrder.findFirstOrThrow({ where: { id: salesOrderId } });
    expect(draft.status).toBe("DRAFT");
    expect(draft.totalCost).toBe(0);
  });

  it("names an unknown SKU instead of silently correcting nothing", async () => {
    const { warehouse, ctx } = await setup();

    const report = await applyCostCorrection(ctx, {
      warehouseId: warehouse.id,
      costs: [...costs, { sku: "no-such-sku", unitCost: LANDED }],
    });

    expect(report.unknownSkus).toEqual(["no-such-sku"]);
    // The known one is still corrected: one bad row must not discard the rest.
    expect(report.lines.map((l) => l.sku)).toEqual(["Pets-large-005"]);
  });

  it("does not touch a product it was not asked about", async () => {
    const { company, warehouse, ctx } = await setup();
    const other = await makeProduct(company.id, "bowl-large-016");
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "bowl-large-016", available: toQty(174), damaged: 0, unitCost: 0 }],
    });

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const untouched = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: other.id } });
    expect(untouched.avgCost).toBe(0);
    expect(untouched.availableQty).toBe(toQty(174));
  });

  it("leaves damaged units out of the revaluation", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id, "Pets-large-005");
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "Pets-large-005", available: toQty(93), damaged: toQty(4), unitCost: 0 }],
    });

    await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    // Damaged stock carries no cost basis by design; revaluing it would invent one.
    expect(balance.damagedQty).toBe(toQty(4));
    expect(balance.availableQty).toBe(toQty(93));
  });
});

describe("planCostCorrection", () => {
  beforeEach(resetDb);

  it("writes nothing, so the plan can be read before it is believed", async () => {
    const { warehouse, ctx, product } = await setup();
    await sell(ctx, warehouse.id, product.id, 2);

    const report = await planCostCorrection(ctx, { warehouseId: warehouse.id, costs });

    expect(report.lines[0].sku).toBe("Pets-large-005");
    expect(report.lines[0].revaluedQty).toBe(toQty(91));
    expect(report.lines[0].restatedOrders).toHaveLength(1);

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    expect(balance.avgCost).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { referenceType: "COST_REVALUATION" } })).toBe(0);
    const order = await prisma.salesOrder.findFirstOrThrow({ where: { companyId: ctx.companyId } });
    expect(order.totalCost).toBe(0);
  });
});

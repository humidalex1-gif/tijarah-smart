import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual } from "@/services/stock";
import {
  createSalesOrder, confirmSale, recomputeOrderCostAllocation, processReturn,
} from "@/services/sales";
import { makeCompany, makeWarehouse, makeProduct, makeAccount, makeCtx, resetDb } from "../../tests/factories";

/**
 * Order costs were read exactly once, inside confirmSale. Anything added
 * afterwards — the warehouse's monthly bill, which cannot arrive before the
 * orders it bills — was written to a table nothing read again, and net profit
 * kept reporting the figure it had at confirmation.
 *
 * Fast Hub charges 16–21 SAR to fulfil an order. On SO-0004 in production
 * that is 16.00 against a gross profit of 18.60: the difference between a
 * healthy order and one that made 2.60.
 */

async function scenario() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id);

  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(10), unitCost: toCost(toMinor(10)),
  });

  const { salesOrderId } = await createSalesOrder(ctx, {
    warehouseId: warehouse.id,
    items: [{ productId: product.id, quantity: toQty(2), unitPrice: toMinor(50) }],
  });
  await confirmSale(ctx, { salesOrderId });

  return { ctx, salesOrderId };
}

describe("recomputeOrderCostAllocation", () => {
  beforeEach(resetDb);

  it("takes a cost added after confirmation off the order's net profit", async () => {
    const { ctx, salesOrderId } = await scenario();
    const before = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    // 100 revenue - 20 cost = 80 gross, and nothing has eaten it yet.
    expect(before.netProfit).toBe(toMinor(80));

    await prisma.salesOrderCost.create({
      data: { salesOrderId, costType: "SHIPPING", amount: toMinor(16), description: "Fast Hub" },
    });
    const result = await recomputeOrderCostAllocation(ctx, salesOrderId);

    expect(result.netProfit).toBe(toMinor(64));
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(after.netProfit).toBe(toMinor(64));
    // Gross profit is untouched: a fulfilment fee is not part of the cost of
    // the goods, and must never look like it is.
    expect(after.grossProfit).toBe(toMinor(80));
    expect(after.totalCost).toBe(toMinor(20));
  });

  it("writes the cost onto the line it was allocated to, not only the order", async () => {
    const { ctx, salesOrderId } = await scenario();
    await prisma.salesOrderCost.create({
      data: { salesOrderId, costType: "SHIPPING", amount: toMinor(16) },
    });

    await recomputeOrderCostAllocation(ctx, salesOrderId);

    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId } });
    expect(item.allocatedShipping).toBe(toMinor(16));
    expect(item.netProfit).toBe(toMinor(64));
  });

  it("is idempotent — running it twice does not charge the fee twice", async () => {
    // It recomputes from the cost rows rather than subtracting from what is
    // already stored, so a repeated post cannot compound.
    const { ctx, salesOrderId } = await scenario();
    await prisma.salesOrderCost.create({
      data: { salesOrderId, costType: "SHIPPING", amount: toMinor(16) },
    });

    await recomputeOrderCostAllocation(ctx, salesOrderId);
    const second = await recomputeOrderCostAllocation(ctx, salesOrderId);

    expect(second.netProfit).toBe(toMinor(64));
  });

  it("refuses an order that is not confirmed", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id);
    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(50) }],
    });

    await expect(recomputeOrderCostAllocation(ctx, salesOrderId)).rejects.toThrow();
  });

  it("does not reach another company's order", async () => {
    const { salesOrderId } = await scenario();
    const other = await makeCompany("Other");

    await expect(recomputeOrderCostAllocation(makeCtx(other.id), salesOrderId)).rejects.toThrow();
  });

  it("keeps a customer return's effect when costs are recomputed afterwards", async () => {
    // The production sequence: order confirmed, customer returns part of it,
    // THEN Fast Hub's monthly bill arrives and is posted. The recompute used
    // to rebuild net profit from item.grossProfit — which processReturn
    // deliberately leaves gross — so posting the bill silently restored the
    // returned profit to the books.
    const { ctx, salesOrderId } = await scenario();
    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId } });
    const account = await makeAccount(ctx.companyId, "Cash", toMinor(1000));

    // Return 1 of 2 units: 50 revenue and 10 cost come back off the order.
    await processReturn(ctx, {
      salesOrderId,
      refundAccountId: account.id,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", refundAmount: toMinor(50),
      }],
    });
    const returned = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    // (100-50) revenue - (20-10) cost = 40 net of the return.
    expect(returned.netProfit).toBe(toMinor(40));

    await prisma.salesOrderCost.create({
      data: { salesOrderId, costType: "SHIPPING", amount: toMinor(16), description: "Fast Hub" },
    });
    const result = await recomputeOrderCostAllocation(ctx, salesOrderId);

    // 40 net of the return, minus the 16 fee — never 80-16=64, which would
    // mean the returned half quietly came back.
    expect(result.netProfit).toBe(toMinor(24));
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(after.netProfit).toBe(toMinor(24));
  });
});

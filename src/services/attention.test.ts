import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toMinor, toCost } from "@/lib/money";
import { pendingActions } from "./attention";
import { receiveStockManual } from "@/services/stock";
import { createSalesOrder, confirmSale } from "@/services/sales";
import {
  makeCompany, makeWarehouse, makeProduct, makeCustomer, makeClaim, makeCtx, resetDb,
} from "../../tests/factories";

/**
 * The dashboard's "what awaits you" card, as one read.
 *
 * Everything here is DERIVED from rows other features already write — it
 * never writes, and each count reuses the definition its own screen uses
 * ("open claim" is claims.ts's `settledAt: null`, "sold" is the reporting
 * module's live statuses), because a card that counts differently from the
 * screen it links to teaches the owner to distrust both.
 */
describe("pendingActions", () => {
  beforeEach(resetDb);

  async function setup() {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    return { company, warehouse, ctx: makeCtx(company.id) };
  }

  it("reports nothing for a company with nothing pending", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "quiet-001");

    const report = await pendingActions(company.id);

    expect(report.zeroCostSold).toBe(0);
    expect(report.openClaims).toBe(0);
    expect(report.draftOrders).toBe(0);
    expect(report.lowStock).toBe(0);
  });

  it("counts a sold product carrying no cost, the gap that inflates profit", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "bowl-large-016");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: 0,
    });
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(30) }],
    });
    await confirmSale(ctx, { salesOrderId });

    expect((await pendingActions(company.id)).zeroCostSold).toBe(1);
  });

  it("does not count a zero-cost product nobody has sold", async () => {
    // Unsold zero cost understates inventory value only; no booked profit
    // depends on it, so it is not an action the owner owes today.
    const { company } = await setup();
    await makeProduct(company.id, "unsold-001");

    expect((await pendingActions(company.id)).zeroCostSold).toBe(0);
  });

  it("does not count a sold product that carries a real cost", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "costed-001");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(12.5)),
    });
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(30) }],
    });
    await confirmSale(ctx, { salesOrderId });

    expect((await pendingActions(company.id)).zeroCostSold).toBe(0);
  });

  it("counts open claims and ignores settled ones", async () => {
    const { company } = await setup();
    const product = await makeProduct(company.id, "claimed-001");
    await makeClaim(company.id, product.id);
    const settled = await makeClaim(company.id, product.id, "DAMAGE");
    await prisma.stockClaim.update({
      where: { id: settled.id },
      data: { settledAt: new Date(), settledQty: settled.quantity },
    });

    expect((await pendingActions(company.id)).openClaims).toBe(1);
  });

  it("counts orders stuck as drafts", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "drafted-001");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: 0,
    });
    // Created and never confirmed — exactly SO-0001's shape.
    await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(30) }],
    });

    expect((await pendingActions(company.id)).draftOrders).toBe(1);
  });

  it("does not count a cancelled draft as pending", async () => {
    // SO-0001 was CANCELLED deliberately, decision on the record. Counting it
    // forever would turn a settled ruling back into an open question.
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "cancelled-001");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: 0,
    });
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(30) }],
    });
    await prisma.salesOrder.update({ where: { id: salesOrderId }, data: { status: "CANCELLED" } });

    expect((await pendingActions(company.id)).draftOrders).toBe(0);
  });

  it("counts products at or under their reorder level", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "low-001");
    await prisma.product.update({ where: { id: product.id }, data: { reorderLevel: toQty(10) } });
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(3), unitCost: 0,
    });

    expect((await pendingActions(company.id)).lowStock).toBe(1);
  });

  it("never counts another company's rows", async () => {
    const { company } = await setup();
    const other = await makeCompany("Other Co");
    const otherProduct = await makeProduct(other.id, "theirs-001");
    await makeClaim(other.id, otherProduct.id);

    const report = await pendingActions(company.id);

    expect(report.openClaims).toBe(0);
  });
});

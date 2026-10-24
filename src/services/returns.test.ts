import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { createSalesOrder, confirmSale, cancelSale, processReturn } from "@/services/sales";
import { receiveStockManual } from "@/services/stock";
import { customerBalance } from "@/services/ledger";
import {
  makeCompany, makeWarehouse, makeProduct, makeCustomer, makeAccount, makeCtx, resetDb,
} from "../../tests/factories";

async function soldOrder(opts: { paid?: boolean } = {}) {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const product = await makeProduct(company.id, "A");
  const customer = await makeCustomer(company.id);
  const account = await makeAccount(company.id);
  const ctx = makeCtx(company.id);

  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(10), unitCost: toCost(toMinor(40)),
  });

  const { salesOrderId } = await createSalesOrder(ctx, {
    customerId: customer.id, warehouseId: warehouse.id,
    items: [{ productId: product.id, quantity: toQty(4), unitPrice: toMinor(100) }],
  });

  await confirmSale(ctx, {
    salesOrderId,
    paidAmount: opts.paid ? toMinor(400) : 0,
    accountId: opts.paid ? account.id : undefined,
  });

  return { company, warehouse, product, customer, account, ctx, salesOrderId };
}

describe("cancelSale", () => {
  beforeEach(resetDb);

  it("restores stock at the original snapshot cost", async () => {
    const { ctx, salesOrderId, product } = await soldOrder();

    await cancelSale(ctx, { salesOrderId, reason: "Customer changed their mind" });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(balance.availableQty).toBe(toQty(10));
    expect(balance.avgCost).toBe(toCost(toMinor(40)));

    const reversal = await prisma.inventoryMovement.findFirstOrThrow({
      where: { movementType: "CANCELLATION_REVERSAL" },
    });
    expect(reversal.direction).toBe("IN");
    expect(reversal.quantity).toBe(toQty(4));
    expect(reversal.unitCost).toBe(toCost(toMinor(40)));
  });

  it("clears the customer receivable and marks the order cancelled", async () => {
    const { company, customer, ctx, salesOrderId } = await soldOrder();

    await cancelSale(ctx, { salesOrderId, reason: "Duplicate order" });

    expect(await customerBalance(prisma, company.id, customer.id)).toBe(0);
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.status).toBe("CANCELLED");
    expect(order.netProfit).toBe(0);
    expect(order.grossProfit).toBe(0);
  });

  it("pays a refund back out of the account that received the money", async () => {
    const { account, ctx, salesOrderId } = await soldOrder({ paid: true });

    const before = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(before.currentBalance).toBe(toMinor(400));

    await cancelSale(ctx, { salesOrderId, reason: "Order cancelled" });

    const after = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.currentBalance).toBe(0);
    await prisma.payment.findFirstOrThrow({ where: { paymentType: "REFUND" } });
  });

  it("keeps the original records instead of deleting them", async () => {
    const { ctx, salesOrderId } = await soldOrder();
    await cancelSale(ctx, { salesOrderId, reason: "Test" });

    expect(await prisma.salesOrder.count()).toBe(1);
    expect(await prisma.salesOrderItem.count()).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { movementType: "SALE" } })).toBe(1);
  });

  it("refuses to cancel a draft or an already-cancelled order", async () => {
    const { ctx, salesOrderId } = await soldOrder();
    await cancelSale(ctx, { salesOrderId, reason: "First" });

    await expect(
      cancelSale(ctx, { salesOrderId, reason: "Second" }),
    ).rejects.toMatchObject({ code: "SALES_ORDER_NOT_CONFIRMED" });
  });

  it("does not refund cash that a return already paid back", async () => {
    const { account, ctx, salesOrderId, warehouse } = await soldOrder({ paid: true });
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await processReturn(ctx, {
      salesOrderId,
      refundAccountId: account.id,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id,
        refundAmount: toMinor(100),
      }],
    });

    await cancelSale(ctx, { salesOrderId, reason: "Cancelled after a cash return" });

    // 400 was collected and 100 already handed back, so the cancellation may
    // only pay out the remaining 300: the account lands at exactly 0, never
    // negative, and the customer is never paid more than they gave us.
    const after = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.currentBalance).toBe(0);

    const refunds = await prisma.payment.findMany({
      where: { salesOrderId, paymentType: "REFUND" },
    });
    expect(refunds.reduce((sum, p) => sum + p.amount, 0)).toBe(toMinor(400));
  });
});

describe("processReturn", () => {
  beforeEach(resetDb);

  it("returns sellable units to available stock at snapshot cost", async () => {
    const { ctx, salesOrderId, product, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    const result = await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id,
        refundAmount: toMinor(100),
      }],
    });

    expect(result.returnNumber).toBe("RET-0001");
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(balance.availableQty).toBe(toQty(7));

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { movementType: "CUSTOMER_RETURN" },
    });
    expect(movement.unitCost).toBe(toCost(toMinor(40)));
  });

  it("sends damaged units to the damaged bucket, not back on sale", async () => {
    const { ctx, salesOrderId, product, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(2),
        condition: "DAMAGED", warehouseId: warehouse.id,
        refundAmount: toMinor(200),
      }],
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(balance.availableQty).toBe(toQty(6));
    expect(balance.damagedQty).toBe(toQty(2));
  });

  it("reduces the order's stored profit by the returned revenue and cost", async () => {
    const { ctx, salesOrderId, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    // Original: revenue 400, cost 160, gross 240.
    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id,
        refundAmount: toMinor(100),
      }],
    });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    // After returning 1 unit: revenue 300, cost 120, gross 180.
    expect(order.grossProfit).toBe(toMinor(180));
    expect(order.netProfit).toBe(toMinor(180));
    expect(order.refundedAmount).toBe(toMinor(100));

    const updatedItem = await prisma.salesOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updatedItem.returnedQty).toBe(toQty(1));
    expect(updatedItem.returnedRevenue).toBe(toMinor(100));
    expect(updatedItem.returnedCost).toBe(toMinor(40));
  });

  it("credits the customer ledger when no refund account is given", async () => {
    const { company, customer, ctx, salesOrderId, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id,
        refundAmount: toMinor(100),
      }],
    });

    // Owed 400, credited 100 back => 300 outstanding.
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(300));
  });

  it("pays cash out of the refund account when one is given", async () => {
    const { company, customer, account, ctx, salesOrderId, warehouse } = await soldOrder({ paid: true });
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    const result = await processReturn(ctx, {
      salesOrderId,
      refundAccountId: account.id,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id,
        refundAmount: toMinor(100),
      }],
    });

    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(300));
    const refundPayment = await prisma.payment.findFirstOrThrow({ where: { paymentType: "REFUND" } });

    // Cash refunds must still land on the customer statement (spec §7): the
    // RETURN credit and REFUND debit net to zero, but both legs are visible.
    const ledgerRows = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
      orderBy: { id: "asc" },
    });
    const returnEntry = ledgerRows.find((r) => r.transactionType === "RETURN");
    const refundEntry = ledgerRows.find((r) => r.transactionType === "REFUND");
    expect(returnEntry).toMatchObject({
      referenceType: "CUSTOMER_RETURN", referenceId: result.returnId, creditAmount: toMinor(100),
    });
    expect(refundEntry).toMatchObject({
      referenceType: "PAYMENT", referenceId: refundPayment.id, debitAmount: toMinor(100),
    });
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(0);
  });

  it("refuses to return more than was sold, across multiple returns", async () => {
    const { ctx, salesOrderId, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(3),
        condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(300),
      }],
    });

    await expect(
      processReturn(ctx, {
        salesOrderId,
        items: [{
          salesOrderItemId: item.id, quantity: toQty(2),
          condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(200),
        }],
      }),
    ).rejects.toMatchObject({ code: "RETURN_EXCEEDS_SOLD" });
  });

  it("refuses to process a return against an unconfirmed order", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const product = await makeProduct(company.id, "A");
    const ctx = makeCtx(company.id);
    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await expect(
      processReturn(ctx, {
        salesOrderId,
        items: [{
          salesOrderItemId: item.id, quantity: toQty(1),
          condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(100),
        }],
      }),
    ).rejects.toMatchObject({ code: "SALES_ORDER_NOT_CONFIRMED" });
  });

  it("refuses to process a return against a cancelled order", async () => {
    const { ctx, salesOrderId, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await cancelSale(ctx, { salesOrderId, reason: "Cancelled before return" });

    await expect(
      processReturn(ctx, {
        salesOrderId,
        items: [{
          salesOrderItemId: item.id, quantity: toQty(1),
          condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(100),
        }],
      }),
    ).rejects.toMatchObject({ code: "SALES_ORDER_NOT_CONFIRMED" });
  });

  it("rejects duplicate lines for the same order item, before anything is written", async () => {
    const { ctx, salesOrderId, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await expect(
      processReturn(ctx, {
        salesOrderId,
        items: [
          {
            salesOrderItemId: item.id, quantity: toQty(1),
            condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(100),
          },
          {
            salesOrderItemId: item.id, quantity: toQty(1),
            condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(100),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_RETURN_LINE" });

    expect(await prisma.customerReturn.count()).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { movementType: "CUSTOMER_RETURN" } })).toBe(0);
    expect(await prisma.payment.count({ where: { paymentType: "REFUND" } })).toBe(0);
    const unchanged = await prisma.salesOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.returnedQty).toBe(0);
    expect(unchanged.returnedRevenue).toBe(0);
  });

  it("refuses a walk-in refund with no destination", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const product = await makeProduct(company.id, "A");
    const ctx = makeCtx(company.id);

    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(40)),
    });
    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(4), unitPrice: toMinor(100) }],
    });
    await confirmSale(ctx, { salesOrderId });
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await expect(
      processReturn(ctx, {
        salesOrderId,
        items: [{
          salesOrderItemId: item.id, quantity: toQty(1),
          condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(100),
        }],
      }),
    ).rejects.toMatchObject({ code: "REFUND_DESTINATION_REQUIRED" });

    expect(await prisma.customerReturn.count()).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { movementType: "CUSTOMER_RETURN" } })).toBe(0);
    const unchanged = await prisma.salesOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.returnedQty).toBe(0);
  });

  it("caps refunds at the order's remaining grand total across multiple returns", async () => {
    // grandTotal is 400 (4 units at 100 each, no tax/discount/shipping).
    const { ctx, salesOrderId, warehouse } = await soldOrder();
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(300),
      }],
    });

    // 300 already refunded; this call asks for 200 more, which would put the
    // order at 500 -- past its 400 grand total.
    await expect(
      processReturn(ctx, {
        salesOrderId,
        items: [{
          salesOrderItemId: item.id, quantity: toQty(1),
          condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(200),
        }],
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_ORDER" });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.refundedAmount).toBe(toMinor(300));
    const unchanged = await prisma.salesOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.returnedQty).toBe(toQty(1));
  });

  it("posts no Payment row and no ledger row for a zero-refund (exchange/restock) return, even with an account supplied", async () => {
    // A straight exchange/restock return moves stock but no money — this
    // must hold even if a caller passes a refundAccountId (the account
    // alone must never be what decides whether a Payment/ledger leg gets
    // written; the AMOUNT does). ReturnForm.tsx no longer sends an account
    // for a zero-refund return, but the service is the actual source of
    // truth and must not depend on the client's own good behavior.
    const { account, ctx, salesOrderId, warehouse, customer, company } = await soldOrder({ paid: true });
    const item = await prisma.salesOrderItem.findFirstOrThrow();
    const ledgerCountBefore = await prisma.customerLedgerEntry.count({ where: { customerId: customer.id } });
    const accountBefore = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });

    await processReturn(ctx, {
      salesOrderId,
      refundAccountId: account.id,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: 0,
      }],
    });

    expect(await prisma.payment.count({ where: { salesOrderId, paymentType: "REFUND" } })).toBe(0);
    const ledgerCountAfter = await prisma.customerLedgerEntry.count({ where: { customerId: customer.id } });
    expect(ledgerCountAfter).toBe(ledgerCountBefore);
    // soldOrder({ paid: true }) collects the full 400 up front, so the
    // customer's balance was already 0 before this zero-refund return — and
    // must stay exactly 0, not drift either way.
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(0);
    const accountAfter = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(accountAfter.currentBalance).toBe(accountBefore.currentBalance);

    // The return itself, and the stock movement, still happen — only the
    // money legs are suppressed.
    const returned = await prisma.salesOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(returned.returnedQty).toBe(toQty(1));
  });

  it("posts no ledger row for a zero-refund return with no account (the credit-note path)", async () => {
    const { ctx, salesOrderId, warehouse, customer } = await soldOrder({ paid: true });
    const item = await prisma.salesOrderItem.findFirstOrThrow();
    const ledgerCountBefore = await prisma.customerLedgerEntry.count({ where: { customerId: customer.id } });

    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: 0,
      }],
    });

    expect(await prisma.payment.count({ where: { salesOrderId, paymentType: "REFUND" } })).toBe(0);
    const ledgerCountAfter = await prisma.customerLedgerEntry.count({ where: { customerId: customer.id } });
    expect(ledgerCountAfter).toBe(ledgerCountBefore);
  });
});

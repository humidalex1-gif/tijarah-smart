import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor, costOf } from "@/lib/money";
import { registerCompany } from "@/services/accounts";
import { createPurchaseOrder, confirmPurchaseOrder, receivePurchase } from "@/services/purchases";
import { createSalesOrder, confirmSale } from "@/services/sales";
import { addExpense } from "@/services/expenses";
import { recordSupplierPayment } from "@/services/payments";
import { salesSummary, inventoryValue, cashPosition, payables } from "@/services/reporting";
import { resetDb } from "../../tests/factories";

const RANGE = {
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-12-31T23:59:59Z"),
};

describe("the whole merchant loop", () => {
  beforeEach(resetDb);

  it("keeps inventory, cost, cash, and profit in agreement end to end", async () => {
    // Register and set up.
    const { userId, companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "demo12345", companyName: "Tijarah Demo",
    });
    const ctx = { companyId, userId };

    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId } });
    const cash = await prisma.financialAccount.findFirstOrThrow({ where: { companyId } });
    await prisma.financialAccount.update({
      where: { id: cash.id },
      data: { openingBalance: toMinor(10_000), currentBalance: toMinor(10_000) },
    });

    const supplier = await prisma.supplier.create({
      data: { companyId, name: "Global Supply" },
    });
    const customer = await prisma.customer.create({
      data: { companyId, name: "Retail Customer" },
    });
    const product = await prisma.product.create({
      data: {
        companyId, nameAr: "سماعات", nameEn: "Headphones",
        sku: "HP-001", sellingPrice: toMinor(250), weightGrams: 300,
      },
    });

    // Buy 100 units at 80.00 with 1,000.00 of shipping => landed 90.00 each.
    const { purchaseOrderId } = await createPurchaseOrder(ctx, {
      supplierId: supplier.id, warehouseId: warehouse.id, allocationMethod: "VALUE",
      items: [{ productId: product.id, orderedQty: toQty(100), unitPrice: toMinor(80) }],
      additionalCosts: [{ costType: "INTERNATIONAL_SHIPPING", amount: toMinor(1000) }],
    });
    await confirmPurchaseOrder(ctx, purchaseOrderId);
    const poItem = await prisma.purchaseOrderItem.findFirstOrThrow();
    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: poItem.id, acceptedQty: toQty(100) }],
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(100));
    expect(balance.avgCost).toBe(toCost(toMinor(90)));

    // We owe the supplier for the goods (not the freight).
    expect(await payables(companyId)).toBe(toMinor(8000));

    // Pay the supplier.
    await recordSupplierPayment(ctx, {
      supplierId: supplier.id, purchaseOrderId,
      accountId: cash.id, amount: toMinor(8000),
    });
    expect(await payables(companyId)).toBe(0);

    // Sell 10 units at 250.00, paid in cash, with a 100.00 delivery cost.
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      orderDate: new Date("2026-06-15T10:00:00Z"),
      items: [{ productId: product.id, quantity: toQty(10), unitPrice: toMinor(250) }],
      costs: [{ costType: "SHIPPING", amount: toMinor(100) }],
    });
    const profit = await confirmSale(ctx, {
      salesOrderId, paidAmount: toMinor(2500), accountId: cash.id,
    });

    // Revenue 2500, cost 10 x 90.00 = 900 => gross 1600, net 1600 - 100 = 1500.
    expect(profit.grossProfit).toBe(toMinor(1600));
    expect(profit.netProfit).toBe(toMinor(1500));

    // Record the delivery cost as a real expense too.
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, nameEn: "Shipping" },
    });
    await addExpense(ctx, {
      categoryId: category.id, accountId: cash.id,
      description: "Courier for SO-0001", amount: toMinor(100),
      expenseDate: new Date("2026-06-15T12:00:00Z"),
    });

    // Every reported number must reconcile.
    const summary = await salesSummary(companyId, RANGE);
    expect(summary.revenue).toBe(toMinor(2500));
    expect(summary.grossProfit).toBe(toMinor(1600));

    const stock = await inventoryValue(companyId);
    expect(stock.totalUnits).toBe(toQty(90));
    expect(stock.totalValue).toBe(toMinor(8100));

    // Cash: 10,000 opening - 8,000 supplier + 2,500 sale - 100 expense = 4,400.
    const position = await cashPosition(companyId);
    expect(position.total).toBe(toMinor(4400));

    // Stock on hand at cost still matches the balance rows exactly.
    const balances = await prisma.inventoryBalance.findMany({ where: { companyId } });
    const derived = balances.reduce((s, b) => s + costOf(b.availableQty, b.avgCost), 0);
    expect(derived).toBe(stock.totalValue);
  });

  it("leaves nothing behind when a sale cannot be confirmed", async () => {
    const { userId, companyId } = await registerCompany({
      fullName: "Owner", email: "owner2@example.com",
      password: "demo12345", companyName: "Tijarah Demo 2",
    });
    const ctx = { companyId, userId };
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId } });
    const product = await prisma.product.create({
      data: { companyId, nameAr: "قلم", nameEn: "Pen", sku: "PEN-1" },
    });

    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(5), unitPrice: toMinor(10) }],
    });

    await expect(confirmSale(ctx, { salesOrderId })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    expect(await prisma.inventoryMovement.count({ where: { companyId } })).toBe(0);
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.status).toBe("DRAFT");
    expect(order.grossProfit).toBe(0);
  });
});

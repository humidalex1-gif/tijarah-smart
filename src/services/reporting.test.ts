import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import {
  salesSummary, expenseTotal, inventoryValue, cashPosition,
  receivables, payables, supplierBalances, customerBalances, lowStockProducts, outOfStockCount, bestSellers, salesSeries,
  productStockSummary, productStockDetail,
  balancesForCompany, warehouseSummary, availableFor, profitWaterfall,
} from "@/services/reporting";
import { receiveStockManual, issueStock } from "@/services/stock";
import { createSalesOrder, confirmSale, cancelSale, processReturn } from "@/services/sales";
import { addExpense } from "@/services/expenses";
import { postReconcile } from "@/services/reconcile";
import { recordAdSpend } from "@/services/adspend";
import { appendSupplierLedger, supplierBalance, appendCustomerLedger, customerBalance } from "@/services/ledger";
import {
  makeCompany, makeWarehouse, makeProduct, makeCustomer, makeSupplier,
  makeAccount, makeExpenseCategory, makeCtx, resetDb,
} from "../../tests/factories";

const RANGE = {
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-12-31T23:59:59Z"),
};

async function tradingCompany() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const product = await makeProduct(company.id, "A", { nameEn: "Widget" });
  const customer = await makeCustomer(company.id);
  const account = await makeAccount(company.id, "Cash", toMinor(1000));
  const ctx = makeCtx(company.id);

  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(20), unitCost: toCost(toMinor(40)),
  });

  return { company, warehouse, product, customer, account, ctx };
}

async function sell(
  ctx: { companyId: string; userId: string | null },
  args: { warehouseId: string; productId: string; customerId?: string; qty: number; price: number; paidAccountId?: string; orderDate?: Date },
) {
  const { salesOrderId } = await createSalesOrder(ctx, {
    customerId: args.customerId,
    warehouseId: args.warehouseId,
    orderDate: args.orderDate ?? new Date("2026-06-15T10:00:00Z"),
    items: [{
      productId: args.productId, quantity: toQty(args.qty), unitPrice: toMinor(args.price),
    }],
  });
  await confirmSale(ctx, {
    salesOrderId,
    paidAmount: args.paidAccountId ? toMinor(args.qty * args.price) : 0,
    accountId: args.paidAccountId,
  });
  return salesOrderId;
}

describe("salesSummary", () => {
  beforeEach(resetDb);

  it("totals revenue and profit from confirmed orders", async () => {
    const { company, warehouse, product, customer, ctx } = await tradingCompany();
    await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      customerId: customer.id, qty: 3, price: 100,
    });

    const summary = await salesSummary(company.id, RANGE);
    expect(summary.orderCount).toBe(1);
    expect(summary.revenue).toBe(toMinor(300));
    expect(summary.grossProfit).toBe(toMinor(180));
    expect(summary.netProfit).toBe(toMinor(180));
  });

  it("excludes cancelled orders", async () => {
    const { company, warehouse, product, customer, ctx } = await tradingCompany();
    const orderId = await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      customerId: customer.id, qty: 3, price: 100,
    });
    await cancelSale(ctx, { salesOrderId: orderId, reason: "Test" });

    const summary = await salesSummary(company.id, RANGE);
    expect(summary.orderCount).toBe(0);
    expect(summary.revenue).toBe(0);
  });

  it("excludes orders outside the range and other companies", async () => {
    const { company, warehouse, product, customer, ctx } = await tradingCompany();
    await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      customerId: customer.id, qty: 1, price: 100,
    });

    const narrow = await salesSummary(company.id, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-31T23:59:59Z"),
    });
    expect(narrow.orderCount).toBe(0);

    const other = await makeCompany("Other Co");
    expect((await salesSummary(other.id, RANGE)).revenue).toBe(0);
  });
});

describe("expenseTotal", () => {
  beforeEach(resetDb);

  it("sums confirmed expenses in the range", async () => {
    const { company, account, ctx } = await tradingCompany();
    const category = await makeExpenseCategory(company.id);

    await addExpense(ctx, {
      categoryId: category.id, accountId: account.id,
      description: "Rent", amount: toMinor(200),
      expenseDate: new Date("2026-06-01T00:00:00Z"),
    });
    await addExpense(ctx, {
      categoryId: category.id, accountId: account.id,
      description: "Ads", amount: toMinor(100), taxAmount: toMinor(15),
      expenseDate: new Date("2026-06-02T00:00:00Z"),
    });

    expect(await expenseTotal(company.id, RANGE)).toBe(toMinor(315));
  });
});

describe("inventoryValue", () => {
  beforeEach(resetDb);

  it("values available stock at its average cost", async () => {
    const { company } = await tradingCompany();
    const value = await inventoryValue(company.id);
    expect(value.totalUnits).toBe(toQty(20));
    expect(value.totalValue).toBe(toMinor(800));
  });

  it("drops as stock is sold", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    await sell(ctx, { warehouseId: warehouse.id, productId: product.id, qty: 5, price: 100 });

    const value = await inventoryValue(company.id);
    expect(value.totalUnits).toBe(toQty(15));
    expect(value.totalValue).toBe(toMinor(600));
  });
});

describe("cashPosition", () => {
  beforeEach(resetDb);

  it("splits cash and bank balances", async () => {
    const { company } = await tradingCompany();
    await prisma.financialAccount.create({
      data: {
        companyId: company.id, name: "Bank", accountType: "BANK",
        currentBalance: toMinor(5000),
      },
    });

    const position = await cashPosition(company.id);
    expect(position.cash).toBe(toMinor(1000));
    expect(position.bank).toBe(toMinor(5000));
    expect(position.total).toBe(toMinor(6000));
  });
});

describe("receivables and payables", () => {
  beforeEach(resetDb);

  it("reports what customers owe from unpaid sales", async () => {
    const { company, warehouse, product, customer, ctx } = await tradingCompany();
    await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      customerId: customer.id, qty: 2, price: 100,
    });

    expect(await receivables(company.id)).toBe(toMinor(200));
  });

  it("ignores customers who are square or in credit", async () => {
    const { company, warehouse, product, customer, account, ctx } = await tradingCompany();
    await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      customerId: customer.id, qty: 2, price: 100, paidAccountId: account.id,
    });

    expect(await receivables(company.id)).toBe(0);
  });

  it("reports what the company owes suppliers", async () => {
    const { company, ctx } = await tradingCompany();
    const supplier = await prisma.supplier.create({
      data: { companyId: company.id, name: "S1" },
    });
    await prisma.supplierLedgerEntry.create({
      data: {
        companyId: company.id, supplierId: supplier.id,
        transactionType: "GOODS_RECEIVED", referenceType: "PURCHASE_ORDER",
        referenceId: "po", referenceNumber: "PO-0001",
        creditAmount: toMinor(700), runningBalance: toMinor(700),
      },
    });
    expect(ctx.companyId).toBe(company.id);
    expect(await payables(company.id)).toBe(toMinor(700));
  });
});

describe("supplierBalances", () => {
  beforeEach(resetDb);

  it("matches supplierBalance for each seeded supplier", async () => {
    const { company } = await tradingCompany();
    const supplierA = await makeSupplier(company.id, "A");
    const supplierB = await makeSupplier(company.id, "B");

    await appendSupplierLedger(prisma, makeCtx(company.id), {
      supplierId: supplierA.id, transactionType: "GOODS_RECEIVED",
      referenceType: "PURCHASE_ORDER", referenceId: "po-a", referenceNumber: "PO-A",
      creditAmount: toMinor(500),
    });
    await appendSupplierLedger(prisma, makeCtx(company.id), {
      supplierId: supplierB.id, transactionType: "GOODS_RECEIVED",
      referenceType: "PURCHASE_ORDER", referenceId: "po-b", referenceNumber: "PO-B",
      creditAmount: toMinor(300),
    });
    await appendSupplierLedger(prisma, makeCtx(company.id), {
      supplierId: supplierB.id, transactionType: "PAYMENT",
      referenceType: "PAYMENT", referenceId: "pay-b", referenceNumber: "PAY-B",
      debitAmount: toMinor(100),
    });

    const balances = await supplierBalances(company.id);
    expect(balances.get(supplierA.id)).toBe(await supplierBalance(prisma, company.id, supplierA.id));
    expect(balances.get(supplierB.id)).toBe(await supplierBalance(prisma, company.id, supplierB.id));
    expect(balances.get(supplierA.id)).toBe(toMinor(500));
    expect(balances.get(supplierB.id)).toBe(toMinor(200));
  });

  it("omits suppliers with no ledger activity", async () => {
    const { company } = await tradingCompany();
    const supplier = await makeSupplier(company.id);

    const balances = await supplierBalances(company.id);
    expect(balances.has(supplier.id)).toBe(false);
  });

  it("scopes to the company", async () => {
    const { company } = await tradingCompany();
    const otherCompany = await makeCompany("Other");
    const otherSupplier = await makeSupplier(otherCompany.id);
    await appendSupplierLedger(prisma, makeCtx(otherCompany.id), {
      supplierId: otherSupplier.id, transactionType: "GOODS_RECEIVED",
      referenceType: "PURCHASE_ORDER", referenceId: "po-x", referenceNumber: "PO-X",
      creditAmount: toMinor(999),
    });

    const balances = await supplierBalances(company.id);
    expect(balances.has(otherSupplier.id)).toBe(false);
  });
});

describe("customerBalances", () => {
  beforeEach(resetDb);

  it("matches customerBalance for each seeded customer", async () => {
    const { company } = await tradingCompany();
    const customerA = await makeCustomer(company.id, "A");
    const customerB = await makeCustomer(company.id, "B");

    await appendCustomerLedger(prisma, makeCtx(company.id), {
      customerId: customerA.id, transactionType: "SALE",
      referenceType: "SALES_ORDER", referenceId: "so-a", referenceNumber: "SO-A",
      debitAmount: toMinor(500),
    });
    await appendCustomerLedger(prisma, makeCtx(company.id), {
      customerId: customerB.id, transactionType: "SALE",
      referenceType: "SALES_ORDER", referenceId: "so-b", referenceNumber: "SO-B",
      debitAmount: toMinor(300),
    });
    await appendCustomerLedger(prisma, makeCtx(company.id), {
      customerId: customerB.id, transactionType: "PAYMENT",
      referenceType: "PAYMENT", referenceId: "pay-b", referenceNumber: "PAY-B",
      creditAmount: toMinor(100),
    });

    const balances = await customerBalances(company.id);
    expect(balances.get(customerA.id)).toBe(await customerBalance(prisma, company.id, customerA.id));
    expect(balances.get(customerB.id)).toBe(await customerBalance(prisma, company.id, customerB.id));
    expect(balances.get(customerA.id)).toBe(toMinor(500));
    expect(balances.get(customerB.id)).toBe(toMinor(200));
  });

  it("omits customers with no ledger activity", async () => {
    const { company, customer } = await tradingCompany();

    const balances = await customerBalances(company.id);
    expect(balances.has(customer.id)).toBe(false);
  });

  it("scopes to the company", async () => {
    const { company } = await tradingCompany();
    const otherCompany = await makeCompany("Other");
    const otherCustomer = await makeCustomer(otherCompany.id);
    await appendCustomerLedger(prisma, makeCtx(otherCompany.id), {
      customerId: otherCustomer.id, transactionType: "SALE",
      referenceType: "SALES_ORDER", referenceId: "so-x", referenceNumber: "SO-X",
      debitAmount: toMinor(999),
    });

    const balances = await customerBalances(company.id);
    expect(balances.has(otherCustomer.id)).toBe(false);
  });
});

describe("lowStockProducts", () => {
  beforeEach(resetDb);

  it("lists products at or below their reorder level", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    await prisma.product.update({
      where: { id: product.id },
      data: { reorderLevel: toQty(18) },
    });

    const before = await lowStockProducts(company.id);
    expect(before).toHaveLength(0);

    await sell(ctx, { warehouseId: warehouse.id, productId: product.id, qty: 5, price: 100 });

    const after = await lowStockProducts(company.id);
    expect(after).toHaveLength(1);
    expect(after[0].sku).toBe("A");
    expect(after[0].availableQty).toBe(toQty(15));
  });

  it("ignores products that do not track inventory", async () => {
    const { company, product } = await tradingCompany();
    await prisma.product.update({
      where: { id: product.id },
      data: { reorderLevel: toQty(50), trackInventory: false },
    });
    expect(await lowStockProducts(company.id)).toHaveLength(0);
  });
});

describe("outOfStockCount", () => {
  beforeEach(resetDb);

  it("counts a product that has never received any stock", async () => {
    // Regression guard: this must NOT be derived from balancesForCompany,
    // which only returns rows for a product/warehouse pair that already has
    // an InventoryBalance row — a never-received product has none, so a
    // balancesForCompany-derived count silently excludes it even though it
    // plainly has zero stock.
    const company = await makeCompany();
    await makeProduct(company.id, "NEVER-RECEIVED");

    expect(await outOfStockCount(company.id)).toBe(1);
  });

  it("does not count a product that has available stock", async () => {
    const { company } = await tradingCompany();
    expect(await outOfStockCount(company.id)).toBe(0);
  });

  it("counts a product whose stock was fully issued back to zero", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id, quantity: toQty(20), reason: "LOST",
    });

    expect(await outOfStockCount(company.id)).toBe(1);
  });

  it("ignores products that do not track inventory", async () => {
    const company = await makeCompany();
    const product = await makeProduct(company.id, "UNTRACKED", { nameEn: "Untracked" });
    await prisma.product.update({ where: { id: product.id }, data: { trackInventory: false } });

    expect(await outOfStockCount(company.id)).toBe(0);
  });

  it("agrees with lowStockProducts about a never-received product (the reported mismatch)", async () => {
    // The concrete scenario this fixes: a never-received, ACTIVE,
    // trackInventory product with a reorder level set shows up in the
    // low-stock KPI (0 <= reorderLevel) — it must also show up in the
    // out-of-stock KPI (0 available), not silently disagree with it.
    const company = await makeCompany();
    const product = await makeProduct(company.id, "NEW-SKU");
    await prisma.product.update({ where: { id: product.id }, data: { reorderLevel: toQty(10) } });

    expect(await lowStockProducts(company.id)).toHaveLength(1);
    expect(await outOfStockCount(company.id)).toBe(1);
  });
});

describe("bestSellers", () => {
  beforeEach(resetDb);

  it("ranks products by revenue with their profit", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    const productB = await makeProduct(company.id, "B", { nameEn: "Gadget" });
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: productB.id,
      quantity: toQty(10), unitCost: toCost(toMinor(10)),
    });

    await sell(ctx, { warehouseId: warehouse.id, productId: product.id, qty: 2, price: 100 });
    await sell(ctx, { warehouseId: warehouse.id, productId: productB.id, qty: 1, price: 50 });

    const top = await bestSellers(company.id, RANGE);
    expect(top[0].nameEn).toBe("Widget");
    expect(top[0].unitsSold).toBe(toQty(2));
    expect(top[0].revenue).toBe(toMinor(200));
    expect(top[0].grossProfit).toBe(toMinor(120));
    expect(top[1].nameEn).toBe("Gadget");
  });

  it("nets returns out so it agrees with salesSummary", async () => {
    const { company, warehouse, product, customer, ctx } = await tradingCompany();
    // customerId is required here: a refund with no refundAccountId needs
    // somewhere to land (store credit against the customer's ledger), or
    // processReturn rejects it with REFUND_DESTINATION_REQUIRED (Task 9 rule).
    const salesOrderId = await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id, customerId: customer.id, qty: 4, price: 100,
    });
    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId } });

    await processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id,
        refundAmount: toMinor(100),
      }],
    });

    // Sold 400 at a cost of 160; one unit came back, so 300 revenue and
    // 180 gross profit. The item-level report must not read the stale
    // posting-time snapshot and disagree with the order-level one.
    const summary = await salesSummary(company.id, RANGE);
    const top = await bestSellers(company.id, RANGE);
    expect(summary.revenue).toBe(toMinor(300));
    expect(top[0].revenue).toBe(toMinor(300));
    expect(summary.grossProfit).toBe(toMinor(180));
    expect(top[0].grossProfit).toBe(toMinor(180));
  });
});

describe("salesSeries", () => {
  beforeEach(resetDb);

  it("returns one zero-filled entry per day with sales landing on their date", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    await sell(ctx, { warehouseId: warehouse.id, productId: product.id, qty: 1, price: 100 });

    const series = await salesSeries(company.id, {
      from: new Date("2026-06-14T00:00:00Z"),
      to: new Date("2026-06-16T00:00:00Z"),
    });

    expect(series).toHaveLength(3);
    expect(series.map((d) => d.date)).toEqual(["2026-06-14", "2026-06-15", "2026-06-16"]);
    expect(series[0].revenue).toBe(0);
    expect(series[1].revenue).toBe(toMinor(100));
    expect(series[1].grossProfit).toBe(toMinor(60));
    expect(series[2].revenue).toBe(0);
  });

  it("includes an order later in the day than the range's `to` timestamp", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    await sell(ctx, {
      warehouseId: warehouse.id, productId: product.id, qty: 1, price: 100,
      orderDate: new Date("2026-06-16T10:00:00Z"),
    });

    const series = await salesSeries(company.id, {
      from: new Date("2026-06-14T00:00:00Z"),
      to: new Date("2026-06-16T00:00:00Z"),
    });

    // The endpoint day is emitted as a bucket, so it must also be filtered in
    // full — otherwise this order vanishes into a zero day.
    expect(series).toHaveLength(3);
    expect(series[2].date).toBe("2026-06-16");
    expect(series[2].revenue).toBe(toMinor(100));
  });
});

describe("productStockSummary", () => {
  beforeEach(resetDb);

  it("sums stock across warehouses and weight-averages the cost", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    // tradingCompany already received 20 units at cost 40.
    const warehouse2 = await makeWarehouse(company.id, "BR");
    await receiveStockManual(ctx, {
      warehouseId: warehouse2.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(70)),
    });

    const summary = await productStockSummary(company.id);
    const row = summary.get(product.id)!;
    expect(row.availableQty).toBe(toQty(30));
    // (20 * 40 + 10 * 70) / 30 = 50
    expect(row.inventoryValue).toBe(toMinor(800) + toMinor(700));
    expect(warehouse.id).not.toBe(warehouse2.id);
  });

  it("returns nothing for a product with no stock rows", async () => {
    const company = await makeCompany();
    const product = await makeProduct(company.id, "NOSTOCK");
    const summary = await productStockSummary(company.id, [product.id]);
    expect(summary.has(product.id)).toBe(false);
  });

  it("only includes the requested company", async () => {
    const { company, product } = await tradingCompany();
    const other = await makeCompany("Other");
    const summary = await productStockSummary(other.id, [product.id]);
    expect(summary.size).toBe(0);
    expect(company.id).not.toBe(other.id);
  });
});

describe("productStockDetail", () => {
  beforeEach(resetDb);

  it("returns one row per warehouse with its own average cost", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    const warehouse2 = await makeWarehouse(company.id, "BR");
    await receiveStockManual(ctx, {
      warehouseId: warehouse2.id, productId: product.id,
      quantity: toQty(5), unitCost: toCost(toMinor(70)),
    });

    const rows = await productStockDetail(company.id, product.id);
    expect(rows).toHaveLength(2);
    const main = rows.find((r) => r.warehouseId === warehouse.id)!;
    const branch = rows.find((r) => r.warehouseId === warehouse2.id)!;
    expect(main.availableQty).toBe(toQty(20));
    expect(main.avgCost).toBe(toCost(toMinor(40)));
    expect(branch.availableQty).toBe(toQty(5));
    expect(branch.avgCost).toBe(toCost(toMinor(70)));
  });
});

describe("balancesForCompany", () => {
  beforeEach(resetDb);

  it("matches the seeded balance and leaves damaged stock out of the value", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    // tradingCompany already received 20 units at cost 40 (value 800).
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(3), reason: "DAMAGED",
    });

    const rows = await balancesForCompany(company.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.productId).toBe(product.id);
    expect(row.warehouseId).toBe(warehouse.id);
    expect(row.availableQty).toBe(toQty(17));
    expect(row.damagedQty).toBe(toQty(3));
    // Damaged units add nothing to value: 17 units at cost 40, not 20.
    expect(row.value).toBe(toMinor(680));
    expect(row.status).toBe("in");
  });

  it("filters by warehouse, category, and stock status", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    const warehouse2 = await makeWarehouse(company.id, "BR");
    const lowProduct = await makeProduct(company.id, "LOW", { nameEn: "LowStock" });
    await prisma.product.update({ where: { id: lowProduct.id }, data: { reorderLevel: toQty(10) } });
    await receiveStockManual(ctx, {
      warehouseId: warehouse2.id, productId: lowProduct.id,
      quantity: toQty(5), unitCost: toCost(toMinor(10)),
    });

    expect(await balancesForCompany(company.id, { warehouseId: warehouse.id })).toHaveLength(1);
    expect(await balancesForCompany(company.id, { warehouseId: warehouse2.id })).toHaveLength(1);
    expect(await balancesForCompany(company.id, { productId: product.id })).toHaveLength(1);

    const low = await balancesForCompany(company.id, { stockStatus: "low" });
    expect(low).toHaveLength(1);
    expect(low[0].productId).toBe(lowProduct.id);

    const inStock = await balancesForCompany(company.id, { stockStatus: "in" });
    expect(inStock).toHaveLength(1);
    expect(inStock[0].productId).toBe(product.id);
  });

  it("only includes the requested company", async () => {
    const { product } = await tradingCompany();
    const other = await makeCompany("Other");
    expect(await balancesForCompany(other.id, { productId: product.id })).toHaveLength(0);
  });
});

describe("warehouseSummary", () => {
  beforeEach(resetDb);

  it("sums to the same total inventoryValue reports", async () => {
    const { company, product, ctx } = await tradingCompany();
    const warehouse2 = await makeWarehouse(company.id, "BR");
    await receiveStockManual(ctx, {
      warehouseId: warehouse2.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(70)),
    });

    const summary = await warehouseSummary(company.id);
    expect(summary).toHaveLength(2);
    const totalFromSummary = summary.reduce((s, w) => s + w.inventoryValue, 0);
    const totalFromInventoryValue = (await inventoryValue(company.id)).totalValue;
    expect(totalFromSummary).toBe(totalFromInventoryValue);
  });

  it("counts SKUs and damaged units per warehouse", async () => {
    const { company, warehouse, product, ctx } = await tradingCompany();
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(2), reason: "DAMAGED",
    });

    const summary = await warehouseSummary(company.id);
    const row = summary.find((w) => w.warehouseId === warehouse.id)!;
    expect(row.skuCount).toBe(1);
    expect(row.totalUnits).toBe(toQty(18));
    expect(row.damagedUnits).toBe(toQty(2));
  });

  it("includes a warehouse with no stock activity, zeroed out", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const summary = await warehouseSummary(company.id);
    expect(summary).toHaveLength(1);
    expect(summary[0].warehouseId).toBe(warehouse.id);
    expect(summary[0].totalUnits).toBe(0);
    expect(summary[0].skuCount).toBe(0);
  });
});

describe("availableFor", () => {
  beforeEach(resetDb);

  it("returns the stocked quantity", async () => {
    const { company, warehouse, product } = await tradingCompany();
    expect(await availableFor(company.id, warehouse.id, product.id)).toBe(toQty(20));
  });

  it("returns 0 for an unstocked product and creates no balance row", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const product = await makeProduct(company.id, "NOSTOCK");

    expect(await availableFor(company.id, warehouse.id, product.id)).toBe(0);
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("does not leak another company's balance", async () => {
    const { warehouse, product } = await tradingCompany();
    const other = await makeCompany("Other");
    expect(await availableFor(other.id, warehouse.id, product.id)).toBe(0);
  });
});

describe("profitWaterfall", () => {
  beforeEach(resetDb);

  async function sold() {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id, "SKU-W");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(100), unitCost: toCost(toMinor(10)),
    });
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(10), unitPrice: toMinor(30), taxRatePct: 0 }],
    });
    await confirmSale(ctx, { salesOrderId });
    return { company, ctx, warehouse, product };
  }

  const range = { from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) };

  it("derives CM1 from stored line data only", async () => {
    const { company, product } = await sold();

    const [row] = await profitWaterfall(company.id, range, new Map());

    expect(row.productId).toBe(product.id);
    expect(row.revenue).toBe(toMinor(300));
    expect(row.cogs).toBe(toMinor(100));
    expect(row.cm1).toBe(toMinor(200));
  });

  it("subtracts advertising at CM2 without touching CM1", async () => {
    const { company, product } = await sold();

    const [row] = await profitWaterfall(
      company.id, range, new Map([[product.id, toMinor(50)]]),
    );

    expect(row.cm1).toBe(toMinor(200));
    expect(row.advertising).toBe(toMinor(50));
    expect(row.cm2).toBe(toMinor(150));
  });

  it("subtracts unexplained shrinkage at CM3", async () => {
    const { company, ctx, warehouse, product } = await sold();
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });

    const [row] = await profitWaterfall(company.id, range, new Map());

    // 90 expected on the shelf, 85 asserted: 5 units lost at cost 10.
    expect(row.shrinkage).toBe(toMinor(50));
    expect(row.cm3).toBe(row.cm2 - toMinor(50));
    expect(row.shrinkageIsIndicative).toBe(false);
  });

  it("counts a damage reclassification once, not once per movement leg", async () => {
    const { company, ctx, warehouse, product } = await sold();
    // 90 on the shelf; the warehouse reports 87 sellable and 3 damaged. The
    // 3 units reclass as AVAILABLE -> DAMAGED, which posts TWO movements (an
    // OUT and an IN) carrying the same quantity and cost. The loss is 3 x 10,
    // not 6 x 10 — summing both legs doubles every damage write-off.
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(87), damaged: toQty(3) }],
    });

    const [row] = await profitWaterfall(company.id, range, new Map());

    expect(row.shrinkage).toBe(toMinor(30));
    expect(row.cm3).toBe(row.cm2 - toMinor(30));
  });

  it("keeps a system-figure loss indicative even after an earlier physical count", async () => {
    const { company, ctx, warehouse, product } = await sold();
    // A verified physical count posts a loss for this product...
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(88) }],
    });
    // ...then a warehouse-system figure posts another. The second loss was
    // never verified; inheriting the first count's credibility presents
    // unaudited bookkeeping as a confirmed loss — per MOVEMENT, not per product.
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: false,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });

    const [row] = await profitWaterfall(company.id, range, new Map());

    expect(row.shrinkage).toBe(toMinor(50));
    expect(row.shrinkageIsIndicative).toBe(true);
  });

  it("records a session carrying the physical-count flag", async () => {
    const { company, ctx, warehouse, product } = await sold();
    const asOf = new Date("2026-02-05T00:00:00.000Z");

    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });

    const sessions = await prisma.reconciliationSession.findMany({
      where: { companyId: company.id },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isPhysicalCount).toBe(true);
    expect(sessions[0].warehouseId).toBe(warehouse.id);
    // asOf is the date the figures describe, not the moment they were posted.
    expect(sessions[0].asOf.toISOString()).toBe(asOf.toISOString());
  });

  it("points the shrinkage movement at its session", async () => {
    const { company, ctx, warehouse, product } = await sold();
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });

    const session = await prisma.reconciliationSession.findFirstOrThrow({
      where: { companyId: company.id },
    });
    const movements = await prisma.inventoryMovement.findMany({
      where: { companyId: company.id, referenceType: "RECONCILIATION" },
    });
    expect(movements.length).toBeGreaterThan(0);
    // The join the profit report relies on, instead of parsing an audit blob.
    for (const movement of movements) {
      expect(movement.referenceId).toBe(session.id);
    }
  });

  it("reads the flag from the session even when the audit payload is gone", async () => {
    // The whole point of the session: the audit log is a log, and a pruned or
    // reshaped row must not silently downgrade a verified count to indicative.
    const { company, ctx, warehouse, product } = await sold();
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });
    await prisma.auditLog.deleteMany({
      where: { companyId: company.id, action: "RECONCILIATION_POSTED" },
    });

    const [row] = await profitWaterfall(company.id, range, new Map());

    expect(row.shrinkageIsIndicative).toBe(false);
  });

  it("flags shrinkage as indicative when the count was not physical", async () => {
    const { company, ctx, warehouse, product } = await sold();
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: false,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });

    const [row] = await profitWaterfall(company.id, range, new Map());

    expect(row.shrinkageIsIndicative).toBe(true);
    expect(row.shrinkage).toBe(toMinor(50));
  });

  it("keeps inventory value and avgCost free of advertising", async () => {
    // The one irreversible mistake this design exists to prevent: ad spend
    // must never reach avgCost or inventory value.
    //
    // An earlier version of this test never called recordAdSpend at all — it
    // passed a Map literal into a pure read and compared two inventoryValue
    // calls, so it would have passed unchanged if recordAdSpend capitalised
    // every riyal into avgCost. It now actually records spend and checks the
    // cost basis itself.
    const { company, ctx, product } = await sold();
    const before = await inventoryValue(company.id);
    const balanceBefore = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });

    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: range.from,
      periodEnd: range.to,
      amount: toMinor(500),
      productId: product.id,
    });

    const after = await inventoryValue(company.id);
    const balanceAfter = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(after.totalValue).toBe(before.totalValue);
    expect(balanceAfter.avgCost).toBe(balanceBefore.avgCost);
  });

  it("includes a product that lost stock but sold nothing in the window", async () => {
    // A report whose whole purpose is profit AFTER loss must not drop the
    // loss. Seeding rows only from sales made a product with shrinkage and no
    // sales vanish from the report entirely.
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id, "SKU-NOSALES");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(20), unitCost: toCost(toMinor(10)),
    });
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(18) }],
    });

    const rows = await profitWaterfall(company.id, range, new Map());

    const row = rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();
    expect(row!.revenue).toBe(0);
    expect(row!.shrinkage).toBe(toMinor(20));
    expect(row!.cm3).toBe(toMinor(-20));
  });

  it("treats shrinkage as indicative when the flag cannot be established", async () => {
    // Every way of failing to read the flag — pruned audit row, malformed
    // payload, renamed key — must land on the CAUTIOUS answer. Defaulting to
    // "confirmed physical count" would present the warehouse's own unverified
    // bookkeeping as a verified loss, which is what the caveat exists for.
    const { company, ctx, warehouse, product } = await sold();
    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(), isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(85) }],
    });
    // BOTH sources removed. The session is the primary one now, so deleting
    // only the audit row no longer loses the flag — that is the improvement,
    // and it is asserted separately. What must not change is where the code
    // lands when neither source can answer.
    await prisma.auditLog.deleteMany({ where: { action: "RECONCILIATION_POSTED" } });
    await prisma.reconciliationSession.deleteMany({ where: { companyId: company.id } });

    const [row] = await profitWaterfall(company.id, range, new Map());

    expect(row.shrinkage).toBe(toMinor(50));
    expect(row.shrinkageIsIndicative).toBe(true);
  });
});

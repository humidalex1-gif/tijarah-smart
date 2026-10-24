import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { createSalesOrder, confirmSale, cancelSale, processReturn } from "@/services/sales";
import { setBundleRecipe } from "@/services/bundles";
import { receiveStockManual } from "@/services/stock";
import { customerBalance } from "@/services/ledger";
import {
  makeCompany, makeWarehouse, makeProduct, makeCustomer, makeAccount, makeCtx, resetDb,
} from "../../tests/factories";

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const product = await makeProduct(company.id, "A");
  const customer = await makeCustomer(company.id);
  const account = await makeAccount(company.id);
  const ctx = makeCtx(company.id);
  // 10 units at a cost of 40.00 each
  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(10), unitCost: toCost(toMinor(40)),
  });
  return { company, warehouse, product, customer, account, ctx };
}

describe("createSalesOrder", () => {
  beforeEach(resetDb);

  it("creates a draft order without touching stock", async () => {
    const { warehouse, product, customer, ctx } = await setup();

    const result = await createSalesOrder(ctx, {
      customerId: customer.id,
      warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(2), unitPrice: toMinor(100) }],
    });

    expect(result.salesOrderNumber).toBe("SO-0001");
    expect(result.grandTotal).toBe(toMinor(200));

    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.status).toBe("DRAFT");
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(10));
  });

  it("includes tax and shipping in the grand total but not in revenue", async () => {
    const { warehouse, product, customer, ctx } = await setup();

    await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      shippingCharged: toMinor(30),
      items: [{
        productId: product.id, quantity: toQty(2),
        unitPrice: toMinor(100), taxRatePct: 1500,
      }],
    });

    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.subtotal).toBe(toMinor(200));
    expect(order.taxTotal).toBe(toMinor(30));
    expect(order.shippingCharged).toBe(toMinor(30));
    expect(order.grandTotal).toBe(toMinor(260));
  });

  it("rejects an order with no items", async () => {
    const { warehouse, customer, ctx } = await setup();
    await expect(
      createSalesOrder(ctx, {
        customerId: customer.id, warehouseId: warehouse.id, items: [],
      }),
    ).rejects.toMatchObject({ code: "NO_LINES" });
  });

  it("rejects a negative order cost amount and creates no order", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    await expect(
      createSalesOrder(ctx, {
        customerId: customer.id, warehouseId: warehouse.id,
        items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
        costs: [{ costType: "SHIPPING", amount: toMinor(-5) }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_COST_AMOUNT" });

    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("rejects an unrecognized order cost type instead of silently bucketing it as OTHER", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    await expect(
      createSalesOrder(ctx, {
        customerId: customer.id, warehouseId: warehouse.id,
        items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
        costs: [{ costType: "BOGUS" as unknown as "OTHER", amount: toMinor(5) }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_COST_TYPE" });

    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("confirmSale", () => {
  beforeEach(resetDb);

  it("deducts stock, snapshots cost, and computes gross profit", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(3), unitPrice: toMinor(100) }],
    });

    const result = await confirmSale(ctx, { salesOrderId });

    // Revenue 300.00, cost 3 x 40.00 = 120.00 => gross 180.00
    expect(result.grossProfit).toBe(toMinor(180));

    const item = await prisma.salesOrderItem.findFirstOrThrow();
    expect(item.unitCostSnapshot).toBe(toCost(toMinor(40)));
    expect(item.totalCost).toBe(toMinor(120));
    expect(item.grossProfit).toBe(toMinor(180));

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(7));

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { movementType: "SALE" },
    });
    expect(movement.direction).toBe("OUT");
    expect(movement.totalCost).toBe(toMinor(120));
  });

  it("subtracts order costs from net profit, allocated by line revenue", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    const productB = await makeProduct(ctx.companyId, "B");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: productB.id,
      quantity: toQty(10), unitCost: toCost(toMinor(10)),
    });

    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [
        { productId: product.id, quantity: toQty(1), unitPrice: toMinor(300) },
        { productId: productB.id, quantity: toQty(1), unitPrice: toMinor(100) },
      ],
      costs: [
        { costType: "SHIPPING", amount: toMinor(40) },
        { costType: "PAYMENT_FEE", amount: toMinor(8) },
      ],
    });

    const result = await confirmSale(ctx, { salesOrderId });

    // Revenue 400.00, cost 40 + 10 = 50.00 => gross 350.00
    // Order costs 48.00 allocated 300:100 => 36.00 / 12.00
    expect(result.grossProfit).toBe(toMinor(350));
    expect(result.netProfit).toBe(toMinor(302));

    const items = await prisma.salesOrderItem.findMany({ orderBy: { unitPrice: "desc" } });
    expect(items[0].allocatedShipping).toBe(toMinor(30));
    expect(items[0].allocatedPaymentFee).toBe(toMinor(6));
    expect(items[0].netProfit).toBe(toMinor(224)); // 300 - 40 gross = 260, minus 36 allocated
    expect(items[1].netProfit).toBe(toMinor(78));  // 100 - 10 gross = 90, minus 12 allocated
  });

  it("counts shipping charged to the customer as order-level revenue", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      shippingCharged: toMinor(25),
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
      costs: [{ costType: "SHIPPING", amount: toMinor(30) }],
    });

    const result = await confirmSale(ctx, { salesOrderId });

    // Gross 100 - 40 = 60. Item net = 60 - 30 shipping cost = 30.
    // Order net = 30 + 25 shipping charged = 55.
    expect(result.grossProfit).toBe(toMinor(60));
    expect(result.netProfit).toBe(toMinor(55));
  });

  it("debits the customer ledger with the grand total when unpaid", async () => {
    const { company, warehouse, product, customer, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await confirmSale(ctx, { salesOrderId });

    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(100));
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.paymentStatus).toBe("UNPAID");
    expect(order.status).toBe("CONFIRMED");
  });

  it("records a full payment, credits the ledger, and increases the account balance", async () => {
    const { company, warehouse, product, customer, account, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await confirmSale(ctx, {
      salesOrderId, paidAmount: toMinor(100), accountId: account.id,
    });

    expect(await customerBalance(prisma, company.id, customer.id)).toBe(0);
    const updatedAccount = await prisma.financialAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(updatedAccount.currentBalance).toBe(toMinor(100));
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.paymentStatus).toBe("PAID");
    expect(order.paidAmount).toBe(toMinor(100));
    await prisma.payment.findFirstOrThrow({ where: { paymentType: "CUSTOMER_PAYMENT" } });
  });

  it("marks a part payment as PARTIAL", async () => {
    const { warehouse, product, customer, account, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await confirmSale(ctx, { salesOrderId, paidAmount: toMinor(40), accountId: account.id });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.paymentStatus).toBe("PARTIAL");
  });

  it("refuses to confirm without enough stock and leaves the order untouched", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(50), unitPrice: toMinor(100) }],
    });

    await expect(confirmSale(ctx, { salesOrderId })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.status).toBe("DRAFT");
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(10));
    expect(await prisma.inventoryMovement.count({ where: { movementType: "SALE" } })).toBe(0);
  });

  it("refuses to confirm the same order twice", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });
    await confirmSale(ctx, { salesOrderId });

    await expect(confirmSale(ctx, { salesOrderId })).rejects.toMatchObject({
      code: "SALES_ORDER_NOT_DRAFT",
    });
  });

  it("supports a walk-in sale with no customer", async () => {
    const { warehouse, product, account, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await confirmSale(ctx, {
      salesOrderId, paidAmount: toMinor(100), accountId: account.id,
    });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.customerId).toBeNull();
    expect(order.paymentStatus).toBe("PAID");
    expect(await prisma.customerLedgerEntry.count()).toBe(0);
  });

  it("requires an account when a payment is supplied", async () => {
    const { warehouse, product, customer, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await expect(
      confirmSale(ctx, { salesOrderId, paidAmount: toMinor(50) }),
    ).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
  });

  it("credits the customer ledger with the created payment's id as referenceId", async () => {
    const { warehouse, product, customer, account, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await confirmSale(ctx, {
      salesOrderId, paidAmount: toMinor(100), accountId: account.id,
    });

    const payment = await prisma.payment.findFirstOrThrow({
      where: { paymentType: "CUSTOMER_PAYMENT" },
    });
    const ledgerEntry = await prisma.customerLedgerEntry.findFirstOrThrow({
      where: { transactionType: "PAYMENT" },
    });
    expect(ledgerEntry.referenceId).toBe(payment.id);
    expect(ledgerEntry.referenceType).toBe("PAYMENT");
    expect(ledgerEntry.referenceNumber).toBe(payment.paymentNumber);
  });

  it("rejects a negative paidAmount and mutates nothing", async () => {
    const { warehouse, product, customer, account, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await expect(
      confirmSale(ctx, { salesOrderId, paidAmount: toMinor(-50), accountId: account.id }),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_AMOUNT" });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.status).toBe("DRAFT");
    expect(await prisma.customerLedgerEntry.count()).toBe(0);
  });

  it("rejects a paidAmount exceeding the grand total and leaves stock untouched", async () => {
    const { warehouse, product, customer, account, ctx } = await setup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(100) }],
    });

    await expect(
      confirmSale(ctx, { salesOrderId, paidAmount: toMinor(150), accountId: account.id }),
    ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_TOTAL" });

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.status).toBe("DRAFT");
    expect(await prisma.inventoryMovement.count({ where: { movementType: "SALE" } })).toBe(0);
  });
});

describe("confirmSale with bundles", () => {
  beforeEach(resetDb);

  async function bundleSetup() {
    const base = await setup();
    const gift = await makeProduct(base.company.id, "GIFT");
    await receiveStockManual(base.ctx, {
      warehouseId: base.warehouse.id, productId: gift.id,
      quantity: toQty(5), unitCost: toCost(toMinor(8)),
    });
    const bundle = await prisma.product.create({
      data: {
        companyId: base.company.id, nameAr: "باقة", nameEn: "Kit",
        sku: "kit-1", trackInventory: false,
      },
    });
    await setBundleRecipe(base.ctx, {
      bundleProductId: bundle.id,
      components: [
        { productId: base.product.id, quantity: toQty(2) },
        { productId: gift.id, quantity: toQty(1) },
      ],
    });
    return { ...base, gift, bundle };
  }

  it("expands a bundle sale into its recipe and costs it at the components", async () => {
    // A bundle owns no shelf. Selling one must remove its COMPONENTS from
    // stock, priced together as the line's cost basis — otherwise the sale
    // depletes nothing and the units surface later as unexplained shrinkage.
    const { warehouse, product, gift, bundle, customer, ctx } = await bundleSetup();

    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: bundle.id, quantity: toQty(1), unitPrice: toMinor(250), taxRatePct: 0 }],
    });
    await confirmSale(ctx, { salesOrderId });

    const productBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    const giftBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: gift.id },
    });
    expect(productBalance.availableQty).toBe(toQty(8));
    expect(giftBalance.availableQty).toBe(toQty(4));

    // The bundle itself never gains or loses a balance row.
    expect(await prisma.inventoryBalance.count({ where: { productId: bundle.id } })).toBe(0);

    // Cost basis = 2 x 40 + 1 x 8 = 88, profit = 250 - 88.
    const item = await prisma.salesOrderItem.findFirstOrThrow();
    expect(item.totalCost).toBe(toMinor(88));
    expect(item.grossProfit).toBe(toMinor(250 - 88));
  });

  it("rejects a recipe-less bundle with the bundle error, not INSUFFICIENT_STOCK", async () => {
    const { warehouse, customer, ctx, company } = await setup();
    const bundle = await prisma.product.create({
      data: {
        companyId: company.id, nameAr: "باقة", nameEn: "Kit",
        sku: "kit-empty", isBundle: true, trackInventory: false,
      },
    });
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: bundle.id, quantity: toQty(1), unitPrice: toMinor(250) }],
    });

    // INSUFFICIENT_STOCK here would read as "the warehouse is out" — a lie.
    // The truth is the recipe is missing, and the error must say so.
    await expect(confirmSale(ctx, { salesOrderId })).rejects.toMatchObject({
      code: "BUNDLE_RECIPE_MISSING",
    });
  });

  it("refuses to cancel a bundle sale instead of minting phantom bundle stock", async () => {
    const { warehouse, bundle, customer, ctx } = await bundleSetup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: bundle.id, quantity: toQty(1), unitPrice: toMinor(250), taxRatePct: 0 }],
    });
    await confirmSale(ctx, { salesOrderId });

    // confirmSale moved the COMPONENTS out; reversing by the line product
    // would mint stock for a product that owns no shelf while the components
    // stay deducted — the same trap processReturn already refuses.
    await expect(cancelSale(ctx, { salesOrderId, reason: "changed mind" }))
      .rejects.toMatchObject({ code: "BUNDLE_CANCEL_UNSUPPORTED" });

    // Nothing moved: no bundle balance minted, order still CONFIRMED.
    expect(await prisma.inventoryBalance.count({ where: { productId: bundle.id } })).toBe(0);
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId } });
    expect(order.status).toBe("CONFIRMED");
  });

  it("refuses to return a bundle line instead of minting phantom bundle stock", async () => {
    const { warehouse, bundle, customer, ctx } = await bundleSetup();
    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: bundle.id, quantity: toQty(1), unitPrice: toMinor(250), taxRatePct: 0 }],
    });
    await confirmSale(ctx, { salesOrderId });
    const item = await prisma.salesOrderItem.findFirstOrThrow();

    // Restocking "one bundle" would create a balance for a product that has
    // no shelf. Which physical components came back is exactly what the
    // return flow (QC at the warehouse) decides — refuse loudly until then.
    await expect(processReturn(ctx, {
      salesOrderId,
      items: [{
        salesOrderItemId: item.id, quantity: toQty(1),
        condition: "SELLABLE", warehouseId: warehouse.id, refundAmount: toMinor(250),
      }],
    })).rejects.toMatchObject({ code: "BUNDLE_RETURN_UNSUPPORTED" });

    expect(await prisma.inventoryBalance.count({ where: { productId: bundle.id } })).toBe(0);
  });
});

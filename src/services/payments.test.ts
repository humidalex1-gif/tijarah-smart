import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toMinor } from "@/lib/money";
import {
  recordCustomerPayment, recordSupplierPayment, transferBetweenAccounts,
} from "@/services/payments";
import { createPurchaseOrder, confirmPurchaseOrder, receivePurchase } from "@/services/purchases";
import { customerBalance, supplierBalance } from "@/services/ledger";
import {
  makeCompany, makeCustomer, makeSupplier, makeAccount, makeWarehouse, makeProduct, makeCtx, resetDb,
} from "../../tests/factories";

describe("recordCustomerPayment", () => {
  beforeEach(resetDb);

  it("increases the account balance and reduces what the customer owes", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const ctx = makeCtx(company.id);

    const result = await recordCustomerPayment(ctx, {
      customerId: customer.id, accountId: account.id, amount: toMinor(250),
    });

    expect(result.paymentNumber).toBe("PAY-0001");
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1250));
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(-250));
  });

  it("updates the linked order's paid amount and payment status", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id);
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        companyId: company.id, salesOrderNumber: "SO-0001",
        customerId: customer.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "CONFIRMED",
      },
    });
    const ctx = makeCtx(company.id);

    await recordCustomerPayment(ctx, {
      customerId: customer.id, salesOrderId: order.id,
      accountId: account.id, amount: toMinor(200),
    });
    let updated = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.paidAmount).toBe(toMinor(200));
    expect(updated.paymentStatus).toBe("PARTIAL");

    await recordCustomerPayment(ctx, {
      customerId: customer.id, salesOrderId: order.id,
      accountId: account.id, amount: toMinor(300),
    });
    updated = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.paidAmount).toBe(toMinor(500));
    expect(updated.paymentStatus).toBe("PAID");
  });

  it("rejects a zero or negative amount", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id);

    await expect(
      recordCustomerPayment(makeCtx(company.id), {
        customerId: customer.id, accountId: account.id, amount: 0,
      }),
    ).rejects.toMatchObject({ code: "AMOUNT_MUST_BE_POSITIVE" });
  });

  it("rejects a payment against another customer's order", async () => {
    const company = await makeCompany();
    const customerA = await makeCustomer(company.id, "Customer A");
    const customerB = await makeCustomer(company.id, "Customer B");
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        companyId: company.id, salesOrderNumber: "SO-0001",
        customerId: customerB.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "CONFIRMED",
      },
    });

    await expect(
      recordCustomerPayment(makeCtx(company.id), {
        customerId: customerA.id, salesOrderId: order.id,
        accountId: account.id, amount: toMinor(100),
      }),
    ).rejects.toThrow();

    expect(await prisma.payment.count()).toBe(0);
    expect(await customerBalance(prisma, company.id, customerA.id)).toBe(0);
    const unchanged = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(unchanged.paidAmount).toBe(0);
    expect(unchanged.paymentStatus).toBe("UNPAID");
  });

  it("rejects a payment that would exceed the order's grand total", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        companyId: company.id, salesOrderNumber: "SO-0001",
        customerId: customer.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "CONFIRMED",
      },
    });

    await expect(
      recordCustomerPayment(makeCtx(company.id), {
        customerId: customer.id, salesOrderId: order.id,
        accountId: account.id, amount: toMinor(600),
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_TOTAL" });

    expect(await prisma.payment.count()).toBe(0);
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1000));
    const unchanged = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(unchanged.paidAmount).toBe(0);
  });

  it("rejects a payment against a cancelled sales order", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        companyId: company.id, salesOrderNumber: "SO-0001",
        customerId: customer.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "CANCELLED",
      },
    });

    await expect(
      recordCustomerPayment(makeCtx(company.id), {
        customerId: customer.id, salesOrderId: order.id,
        accountId: account.id, amount: toMinor(100),
      }),
    ).rejects.toMatchObject({ code: "ORDER_CANCELLED" });

    expect(await prisma.payment.count()).toBe(0);
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1000));
  });

  it("rejects a payment against a still-DRAFT sales order", async () => {
    // confirmSale sets `paidAmount` from its OWN paidAmount argument,
    // overwriting whatever is already on the row — a payment recorded here
    // while the order is still DRAFT would post real money (Payment row,
    // ledger credit, account debit) and then have its contribution to
    // order.paidAmount silently clobbered the moment the order is
    // confirmed, stranding that payment's ledger/cash legs with nothing on
    // the order to show for them. Only a CONFIRMED order may take one.
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        companyId: company.id, salesOrderNumber: "SO-0001",
        customerId: customer.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "DRAFT",
      },
    });

    await expect(
      recordCustomerPayment(makeCtx(company.id), {
        customerId: customer.id, salesOrderId: order.id,
        accountId: account.id, amount: toMinor(100),
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_CONFIRMED" });

    expect(await prisma.payment.count()).toBe(0);
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1000));
    const unchanged = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(unchanged.paidAmount).toBe(0);
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(0);
  });

  it("still allows a customer payment with no linked order at all, regardless of any order's status", async () => {
    // The DRAFT guard only applies when a salesOrderId is actually passed —
    // a general account-credit payment (no order) is unaffected.
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));

    const result = await recordCustomerPayment(makeCtx(company.id), {
      customerId: customer.id, accountId: account.id, amount: toMinor(100),
    });

    expect(result.paymentNumber).toBeDefined();
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(-100));
  });
});

describe("recordSupplierPayment", () => {
  beforeEach(resetDb);

  it("decreases the account balance and what we owe the supplier", async () => {
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const ctx = makeCtx(company.id);

    await recordSupplierPayment(ctx, {
      supplierId: supplier.id, accountId: account.id, amount: toMinor(400),
    });

    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(600));
    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(toMinor(-400));
  });

  it("updates the linked purchase order's paid amount", async () => {
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(5000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: company.id, purchaseOrderNumber: "PO-0001",
        supplierId: supplier.id, warehouseId: warehouse.id,
        grandTotal: toMinor(1000), status: "CONFIRMED",
      },
    });

    await recordSupplierPayment(makeCtx(company.id), {
      supplierId: supplier.id, purchaseOrderId: po.id,
      accountId: account.id, amount: toMinor(1000),
    });

    const updated = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(updated.paidAmount).toBe(toMinor(1000));
    expect(updated.paymentStatus).toBe("PAID");
  });

  it("allows a payment against a still-DRAFT purchase order, and confirming it later does not strand that payment", async () => {
    // Unlike confirmSale (which overwrites SalesOrder.paidAmount wholesale
    // from its own paidAmount argument — see the DRAFT guard added to
    // recordCustomerPayment above), confirmPurchaseOrder only ever writes
    // `status: "CONFIRMED"` (src/services/purchases.ts) and never touches
    // `paidAmount` at all. A payment recorded here while the PO is still
    // DRAFT therefore is NOT clobbered by a later confirm — the same
    // stranding bug does not exist on this side, so no equivalent guard is
    // added here. This test documents/pins that behavior rather than
    // asserting a rejection.
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(5000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: company.id, purchaseOrderNumber: "PO-0001",
        supplierId: supplier.id, warehouseId: warehouse.id,
        grandTotal: toMinor(1000), status: "DRAFT",
      },
    });
    const ctx = makeCtx(company.id);

    await recordSupplierPayment(ctx, {
      supplierId: supplier.id, purchaseOrderId: po.id,
      accountId: account.id, amount: toMinor(400),
    });
    const afterPayment = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(afterPayment.paidAmount).toBe(toMinor(400));

    await confirmPurchaseOrder(ctx, po.id);

    const afterConfirm = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(afterConfirm.status).toBe("CONFIRMED");
    expect(afterConfirm.paidAmount).toBe(toMinor(400));
    expect(await prisma.payment.count({ where: { purchaseOrderId: po.id } })).toBe(1);
  });

  it("rejects a payment against another supplier's purchase order", async () => {
    const company = await makeCompany();
    const supplierA = await makeSupplier(company.id, "Supplier A");
    const supplierB = await makeSupplier(company.id, "Supplier B");
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: company.id, purchaseOrderNumber: "PO-0001",
        supplierId: supplierB.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "CONFIRMED",
      },
    });

    await expect(
      recordSupplierPayment(makeCtx(company.id), {
        supplierId: supplierA.id, purchaseOrderId: po.id,
        accountId: account.id, amount: toMinor(100),
      }),
    ).rejects.toThrow();

    expect(await prisma.payment.count()).toBe(0);
    expect(await supplierBalance(prisma, company.id, supplierA.id)).toBe(0);
    const unchanged = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(unchanged.paidAmount).toBe(0);
    expect(unchanged.paymentStatus).toBe("UNPAID");
  });

  it("rejects a payment against a cancelled purchase order", async () => {
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const account = await makeAccount(company.id, "Cash", toMinor(1000));
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: company.id, purchaseOrderNumber: "PO-0001",
        supplierId: supplier.id, warehouseId: warehouse.id,
        grandTotal: toMinor(500), status: "CANCELLED",
      },
    });

    await expect(
      recordSupplierPayment(makeCtx(company.id), {
        supplierId: supplier.id, purchaseOrderId: po.id,
        accountId: account.id, amount: toMinor(100),
      }),
    ).rejects.toMatchObject({ code: "ORDER_CANCELLED" });

    expect(await prisma.payment.count()).toBe(0);
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1000));
  });

  it("caps a supplier payment at goods+tax (AP), not the PO's grandTotal", async () => {
    // Additional costs (freight, customs, ...) are deliberately not a
    // supplier payable — AP is credited at receive time for goods+tax only.
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const warehouse = await makeWarehouse(company.id);
    const product = await makeProduct(company.id, "A");
    const account = await makeAccount(company.id, "Cash", toMinor(10_000));
    const ctx = makeCtx(company.id);

    const { purchaseOrderId } = await createPurchaseOrder(ctx, {
      supplierId: supplier.id, warehouseId: warehouse.id,
      items: [{
        productId: product.id, orderedQty: toQty(10),
        unitPrice: toMinor(100), taxRatePct: 1000,
      }],
      additionalCosts: [{ costType: "CUSTOMS", amount: toMinor(50) }],
    });
    await confirmPurchaseOrder(ctx, purchaseOrderId);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId } });
    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: item.id, acceptedQty: toQty(10) }],
    });

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    // subtotal 1000.00 + 10% tax 100.00 => AP (goods+tax) 1100.00;
    // additionalCostTotal 50.00 => grandTotal 1150.00.
    const apCap = po.grandTotal - po.additionalCostTotal;
    expect(apCap).toBe(toMinor(1100));

    await recordSupplierPayment(ctx, {
      supplierId: supplier.id, purchaseOrderId, accountId: account.id, amount: apCap,
    });
    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(0);

    await expect(
      recordSupplierPayment(ctx, {
        supplierId: supplier.id, purchaseOrderId, accountId: account.id,
        amount: po.grandTotal - apCap, // would bring the total paid to grandTotal, past the AP cap
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_TOTAL" });
  });

  it("marks a PO with additional costs PAID once goods+tax are settled", async () => {
    // Payment status is derived against the same payable the cap enforces.
    // Measured against grandTotal, a PO carrying additional costs could
    // never reach PAID — the cap forbids ever paying that much.
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const warehouse = await makeWarehouse(company.id);
    const product = await makeProduct(company.id, "A");
    const account = await makeAccount(company.id, "Cash", toMinor(10_000));
    const ctx = makeCtx(company.id);

    const { purchaseOrderId } = await createPurchaseOrder(ctx, {
      supplierId: supplier.id, warehouseId: warehouse.id,
      items: [{
        productId: product.id, orderedQty: toQty(10),
        unitPrice: toMinor(100), taxRatePct: 1000,
      }],
      additionalCosts: [{ costType: "CUSTOMS", amount: toMinor(50) }],
    });
    await confirmPurchaseOrder(ctx, purchaseOrderId);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId } });
    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: item.id, acceptedQty: toQty(10) }],
    });

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    const payable = po.grandTotal - po.additionalCostTotal;
    expect(po.additionalCostTotal).toBeGreaterThan(0);

    // A part payment is still PARTIAL.
    await recordSupplierPayment(ctx, {
      supplierId: supplier.id, purchaseOrderId, accountId: account.id, amount: toMinor(600),
    });
    let updated = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(updated.paymentStatus).toBe("PARTIAL");

    // Settling the rest of goods+tax completes it.
    await recordSupplierPayment(ctx, {
      supplierId: supplier.id, purchaseOrderId, accountId: account.id,
      amount: payable - toMinor(600),
    });
    updated = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(updated.paidAmount).toBe(payable);
    expect(updated.paymentStatus).toBe("PAID");
  });
});

describe("transferBetweenAccounts", () => {
  beforeEach(resetDb);

  it("moves money from one account to the other", async () => {
    const company = await makeCompany();
    const cash = await makeAccount(company.id, "Cash", toMinor(1000));
    const bank = await prisma.financialAccount.create({
      data: { companyId: company.id, name: "Bank", accountType: "BANK" },
    });

    await transferBetweenAccounts(makeCtx(company.id), {
      fromAccountId: cash.id, toAccountId: bank.id, amount: toMinor(300),
    });

    const updatedCash = await prisma.financialAccount.findUniqueOrThrow({ where: { id: cash.id } });
    const updatedBank = await prisma.financialAccount.findUniqueOrThrow({ where: { id: bank.id } });
    expect(updatedCash.currentBalance).toBe(toMinor(700));
    expect(updatedBank.currentBalance).toBe(toMinor(300));
  });

  it("rejects a transfer to the same account", async () => {
    const company = await makeCompany();
    const cash = await makeAccount(company.id, "Cash", toMinor(1000));

    await expect(
      transferBetweenAccounts(makeCtx(company.id), {
        fromAccountId: cash.id, toAccountId: cash.id, amount: toMinor(100),
      }),
    ).rejects.toMatchObject({ code: "SAME_ACCOUNT" });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import {
  appendSupplierLedger, appendCustomerLedger, supplierBalance, customerBalance,
} from "@/services/ledger";
import { makeCompany, makeSupplier, makeCustomer, makeCtx, resetDb } from "../../tests/factories";

const ref = { referenceType: "PURCHASE_ORDER", referenceId: "po1", referenceNumber: "PO-0001" };

describe("supplier ledger", () => {
  beforeEach(resetDb);

  it("credits increase what we owe the supplier", async () => {
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const ctx = makeCtx(company.id);

    const balance = await appendSupplierLedger(prisma, ctx, {
      supplierId: supplier.id, transactionType: "GOODS_RECEIVED",
      creditAmount: toMinor(1000), ...ref,
    });

    expect(balance).toBe(toMinor(1000));
    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(toMinor(1000));
  });

  it("debits reduce what we owe and carry the running balance forward", async () => {
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const ctx = makeCtx(company.id);

    await appendSupplierLedger(prisma, ctx, {
      supplierId: supplier.id, transactionType: "GOODS_RECEIVED",
      creditAmount: toMinor(1000), ...ref,
    });
    const after = await appendSupplierLedger(prisma, ctx, {
      supplierId: supplier.id, transactionType: "PAYMENT",
      debitAmount: toMinor(400), ...ref,
    });

    expect(after).toBe(toMinor(600));
    const entries = await prisma.supplierLedgerEntry.findMany({ orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => e.runningBalance)).toEqual([toMinor(1000), toMinor(600)]);
  });

  it("computes correct running balances when two rows share a createdAt timestamp", async () => {
    const company = await makeCompany();
    const supplier = await makeSupplier(company.id);
    const ctx = makeCtx(company.id);

    let firstBalance = 0;
    let secondBalance = 0;
    await prisma.$transaction(async (tx) => {
      firstBalance = await appendSupplierLedger(tx, ctx, {
        supplierId: supplier.id, transactionType: "GOODS_RECEIVED",
        creditAmount: toMinor(1000), ...ref,
      });
      secondBalance = await appendSupplierLedger(tx, ctx, {
        supplierId: supplier.id, transactionType: "PAYMENT",
        debitAmount: toMinor(400), ...ref,
      });
    });

    expect(firstBalance).toBe(toMinor(1000));
    expect(secondBalance).toBe(toMinor(600));

    const entries = await prisma.supplierLedgerEntry.findMany({
      where: { companyId: company.id, supplierId: supplier.id },
    });
    expect(entries).toHaveLength(2);
    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(toMinor(600));

    // Force a deterministic tie: both existing rows now share one createdAt.
    // A "read the latest row by createdAt" implementation has no real winner
    // here — SQLite's stable sort returns the first-inserted row (runningBalance
    // 1000), which would compute the wrong prior balance for the next append.
    await prisma.supplierLedgerEntry.updateMany({
      where: { companyId: company.id, supplierId: supplier.id },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const tied = await prisma.supplierLedgerEntry.findMany({
      where: { companyId: company.id, supplierId: supplier.id },
    });
    expect(tied[0].createdAt.getTime()).toBe(tied[1].createdAt.getTime());

    const thirdBalance = await appendSupplierLedger(prisma, ctx, {
      supplierId: supplier.id, transactionType: "PAYMENT",
      debitAmount: toMinor(100), ...ref,
    });

    expect(thirdBalance).toBe(toMinor(500));
    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(toMinor(500));
  });

  it("keeps balances separate per supplier", async () => {
    const company = await makeCompany();
    const a = await makeSupplier(company.id, "A");
    const b = await makeSupplier(company.id, "B");
    const ctx = makeCtx(company.id);

    await appendSupplierLedger(prisma, ctx, {
      supplierId: a.id, transactionType: "GOODS_RECEIVED", creditAmount: toMinor(500), ...ref,
    });

    expect(await supplierBalance(prisma, company.id, b.id)).toBe(0);
  });
});

describe("customer ledger", () => {
  beforeEach(resetDb);

  it("debits increase what the customer owes, credits reduce it", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const ctx = makeCtx(company.id);

    await appendCustomerLedger(prisma, ctx, {
      customerId: customer.id, transactionType: "SALE",
      debitAmount: toMinor(800),
      referenceType: "SALES_ORDER", referenceId: "so1", referenceNumber: "SO-0001",
    });
    const after = await appendCustomerLedger(prisma, ctx, {
      customerId: customer.id, transactionType: "PAYMENT",
      creditAmount: toMinor(300),
      referenceType: "PAYMENT", referenceId: "pay1", referenceNumber: "PAY-0001",
    });

    expect(after).toBe(toMinor(500));
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(500));
  });

  it("computes correct running balances when two rows share a createdAt timestamp", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    const ctx = makeCtx(company.id);

    let firstBalance = 0;
    let secondBalance = 0;
    await prisma.$transaction(async (tx) => {
      firstBalance = await appendCustomerLedger(tx, ctx, {
        customerId: customer.id, transactionType: "SALE",
        debitAmount: toMinor(800),
        referenceType: "SALES_ORDER", referenceId: "so1", referenceNumber: "SO-0001",
      });
      secondBalance = await appendCustomerLedger(tx, ctx, {
        customerId: customer.id, transactionType: "PAYMENT",
        creditAmount: toMinor(300),
        referenceType: "PAYMENT", referenceId: "pay1", referenceNumber: "PAY-0001",
      });
    });

    expect(firstBalance).toBe(toMinor(800));
    expect(secondBalance).toBe(toMinor(500));

    const entries = await prisma.customerLedgerEntry.findMany({
      where: { companyId: company.id, customerId: customer.id },
    });
    expect(entries).toHaveLength(2);
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(500));

    // Force a deterministic tie: both existing rows now share one createdAt.
    // A "read the latest row by createdAt" implementation has no real winner
    // here — SQLite's stable sort returns the first-inserted row (runningBalance
    // 800), which would compute the wrong prior balance for the next append.
    await prisma.customerLedgerEntry.updateMany({
      where: { companyId: company.id, customerId: customer.id },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const tied = await prisma.customerLedgerEntry.findMany({
      where: { companyId: company.id, customerId: customer.id },
    });
    expect(tied[0].createdAt.getTime()).toBe(tied[1].createdAt.getTime());

    const thirdBalance = await appendCustomerLedger(prisma, ctx, {
      customerId: customer.id, transactionType: "PAYMENT",
      creditAmount: toMinor(100),
      referenceType: "PAYMENT", referenceId: "pay2", referenceNumber: "PAY-0002",
    });

    expect(thirdBalance).toBe(toMinor(400));
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(toMinor(400));
  });

  it("returns zero for a customer with no entries", async () => {
    const company = await makeCompany();
    const customer = await makeCustomer(company.id);
    expect(await customerBalance(prisma, company.id, customer.id)).toBe(0);
  });
});

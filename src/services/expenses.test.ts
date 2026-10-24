import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import { addExpense, cancelExpense } from "@/services/expenses";
import {
  makeCompany, makeAccount, makeExpenseCategory, makeCtx, resetDb,
} from "../../tests/factories";

describe("addExpense", () => {
  beforeEach(resetDb);

  it("numbers the expense and reduces the paying account", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);

    const result = await addExpense(makeCtx(company.id), {
      categoryId: category.id, accountId: account.id,
      description: "Office rent", amount: toMinor(500),
    });

    expect(result.expenseNumber).toBe("EXP-0001");
    expect(result.totalAmount).toBe(toMinor(500));
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1500));
  });

  it("adds tax to the total charged against the account", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);

    const result = await addExpense(makeCtx(company.id), {
      categoryId: category.id, accountId: account.id,
      description: "Courier", amount: toMinor(100), taxAmount: toMinor(15),
    });

    expect(result.totalAmount).toBe(toMinor(115));
    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(1885));
  });

  it("writes an audit record", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);

    await addExpense(makeCtx(company.id), {
      categoryId: category.id, accountId: account.id,
      description: "Ads", amount: toMinor(50),
    });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "EXPENSE_ADDED" } });
    expect(log.entityType).toBe("Expense");
  });

  it("rejects a zero amount", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id);
    const category = await makeExpenseCategory(company.id);

    await expect(
      addExpense(makeCtx(company.id), {
        categoryId: category.id, accountId: account.id, description: "Nothing", amount: 0,
      }),
    ).rejects.toMatchObject({ code: "AMOUNT_MUST_BE_POSITIVE" });
  });

  it("rejects a negative tax amount instead of minting money into the account", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);

    await expect(
      addExpense(makeCtx(company.id), {
        categoryId: category.id, accountId: account.id,
        description: "Bad entry", amount: toMinor(100), taxAmount: -toMinor(500),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TAX_AMOUNT" });

    const unchanged = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(unchanged.currentBalance).toBe(toMinor(2000));
  });
});

describe("cancelExpense", () => {
  beforeEach(resetDb);

  it("returns the money to the account and marks the expense cancelled", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);
    const ctx = makeCtx(company.id);

    const { expenseId } = await addExpense(ctx, {
      categoryId: category.id, accountId: account.id,
      description: "Wrong entry", amount: toMinor(300),
    });

    await cancelExpense(ctx, expenseId, "Entered twice");

    const updated = await prisma.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.currentBalance).toBe(toMinor(2000));
    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.status).toBe("CANCELLED");
  });

  it("refuses to cancel twice", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);
    const ctx = makeCtx(company.id);
    const { expenseId } = await addExpense(ctx, {
      categoryId: category.id, accountId: account.id, description: "X", amount: toMinor(10),
    });
    await cancelExpense(ctx, expenseId, "First");

    await expect(cancelExpense(ctx, expenseId, "Second")).rejects.toMatchObject({
      code: "ALREADY_CANCELLED",
    });
  });

  it("appends the cancellation reason instead of overwriting existing notes", async () => {
    const company = await makeCompany();
    const account = await makeAccount(company.id, "Cash", toMinor(2000));
    const category = await makeExpenseCategory(company.id);
    const ctx = makeCtx(company.id);
    const { expenseId } = await addExpense(ctx, {
      categoryId: category.id, accountId: account.id, description: "X",
      amount: toMinor(10), notes: "Paid via petty cash",
    });

    await cancelExpense(ctx, expenseId, "Entered twice");

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.notes).toBe("Paid via petty cash | CANCELLED: Entered twice");
  });
});

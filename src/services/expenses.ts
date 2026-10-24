import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";
import { ServiceError, invalidState } from "@/services/errors";
import { adjustAccount } from "@/services/accounts-balance";

export async function addExpense(
  ctx: ServiceContext,
  input: {
    categoryId: string; accountId: string;
    supplierId?: string; warehouseId?: string;
    expenseDate?: Date; description: string;
    amount: number; taxAmount?: number;
    receiptUrl?: string; notes?: string;
  },
) {
  if (input.amount <= 0) throw new ServiceError("AMOUNT_MUST_BE_POSITIVE");
  if ((input.taxAmount ?? 0) < 0) throw invalidState("INVALID_TAX_AMOUNT");

  return prisma.$transaction(async (tx) => {
    await tx.expenseCategory.findFirstOrThrow({
      where: { id: input.categoryId, companyId: ctx.companyId },
    });
    await tx.financialAccount.findFirstOrThrow({
      where: { id: input.accountId, companyId: ctx.companyId },
    });
    if (input.supplierId) {
      await tx.supplier.findFirstOrThrow({
        where: { id: input.supplierId, companyId: ctx.companyId },
      });
    }
    if (input.warehouseId) {
      await tx.warehouse.findFirstOrThrow({
        where: { id: input.warehouseId, companyId: ctx.companyId },
      });
    }

    const expenseNumber = await nextNumber(tx, ctx.companyId, "EXP");
    const totalAmount = input.amount + (input.taxAmount ?? 0);

    const expense = await tx.expense.create({
      data: {
        companyId: ctx.companyId,
        expenseNumber,
        categoryId: input.categoryId,
        accountId: input.accountId,
        supplierId: input.supplierId ?? null,
        warehouseId: input.warehouseId ?? null,
        expenseDate: input.expenseDate ?? new Date(),
        description: input.description,
        amount: input.amount,
        taxAmount: input.taxAmount ?? 0,
        totalAmount,
        receiptUrl: input.receiptUrl ?? null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    await adjustAccount(tx, ctx.companyId, input.accountId, -totalAmount);

    await writeAudit(tx, ctx, {
      action: "EXPENSE_ADDED",
      entityType: "Expense",
      entityId: expense.id,
      newValues: { expenseNumber, totalAmount, description: input.description },
    });

    return { expenseId: expense.id, expenseNumber, totalAmount };
  });
}

export async function cancelExpense(ctx: ServiceContext, expenseId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findFirstOrThrow({
      where: { id: expenseId, companyId: ctx.companyId },
    });
    if (expense.status === "CANCELLED") throw new ServiceError("ALREADY_CANCELLED");

    await adjustAccount(tx, ctx.companyId, expense.accountId, expense.totalAmount);

    await tx.expense.update({
      where: { id: expense.id },
      data: {
        status: "CANCELLED",
        notes: expense.notes ? `${expense.notes} | CANCELLED: ${reason}` : reason,
      },
    });

    await writeAudit(tx, ctx, {
      action: "EXPENSE_CANCELLED",
      entityType: "Expense",
      entityId: expense.id,
      oldValues: { status: expense.status },
      newValues: { status: "CANCELLED", reason },
    });
  });
}

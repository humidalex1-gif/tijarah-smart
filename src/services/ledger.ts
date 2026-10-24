import type { Tx } from "@/lib/db";
import type { ServiceContext } from "@/services/context";

interface LedgerEntry {
  transactionType: string;
  referenceType: string;
  referenceId: string;
  referenceNumber: string;
  debitAmount?: number;
  creditAmount?: number;
  transactionDate?: Date;
}

/** Positive balance = the company owes the supplier. */
export async function appendSupplierLedger(
  tx: Tx,
  ctx: ServiceContext,
  entry: LedgerEntry & { supplierId: string },
): Promise<number> {
  // Rows written back-to-back in one transaction share a `createdAt`, so the
  // newest row is not identifiable by ordering. Aggregate the account instead.
  const agg = await tx.supplierLedgerEntry.aggregate({
    where: { companyId: ctx.companyId, supplierId: entry.supplierId },
    _sum: { creditAmount: true, debitAmount: true },
  });
  const priorBalance = (agg._sum.creditAmount ?? 0) - (agg._sum.debitAmount ?? 0);

  const debit = entry.debitAmount ?? 0;
  const credit = entry.creditAmount ?? 0;
  const runningBalance = priorBalance + credit - debit;

  await tx.supplierLedgerEntry.create({
    data: {
      companyId: ctx.companyId,
      supplierId: entry.supplierId,
      transactionDate: entry.transactionDate ?? new Date(),
      transactionType: entry.transactionType,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      referenceNumber: entry.referenceNumber,
      debitAmount: debit,
      creditAmount: credit,
      runningBalance,
    },
  });

  return runningBalance;
}

/** Positive balance = the customer owes the company. */
export async function appendCustomerLedger(
  tx: Tx,
  ctx: ServiceContext,
  entry: LedgerEntry & { customerId: string },
): Promise<number> {
  // Same tie problem as the supplier ledger — aggregate, do not order.
  const agg = await tx.customerLedgerEntry.aggregate({
    where: { companyId: ctx.companyId, customerId: entry.customerId },
    _sum: { debitAmount: true, creditAmount: true },
  });
  const priorBalance = (agg._sum.debitAmount ?? 0) - (agg._sum.creditAmount ?? 0);

  const debit = entry.debitAmount ?? 0;
  const credit = entry.creditAmount ?? 0;
  const runningBalance = priorBalance + debit - credit;

  await tx.customerLedgerEntry.create({
    data: {
      companyId: ctx.companyId,
      customerId: entry.customerId,
      transactionDate: entry.transactionDate ?? new Date(),
      transactionType: entry.transactionType,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      referenceNumber: entry.referenceNumber,
      debitAmount: debit,
      creditAmount: credit,
      runningBalance,
    },
  });

  return runningBalance;
}

export async function supplierBalance(tx: Tx, companyId: string, supplierId: string) {
  const agg = await tx.supplierLedgerEntry.aggregate({
    where: { companyId, supplierId },
    _sum: { creditAmount: true, debitAmount: true },
  });
  return (agg._sum.creditAmount ?? 0) - (agg._sum.debitAmount ?? 0);
}

export async function customerBalance(tx: Tx, companyId: string, customerId: string) {
  const agg = await tx.customerLedgerEntry.aggregate({
    where: { companyId, customerId },
    _sum: { debitAmount: true, creditAmount: true },
  });
  return (agg._sum.debitAmount ?? 0) - (agg._sum.creditAmount ?? 0);
}

import type { Tx } from "@/lib/db";

/**
 * The only sanctioned path for mutating FinancialAccount.currentBalance.
 * Every caller that adjusts a balance — payments, expenses, sales, refunds,
 * onboarding — must route through here instead of hand-rolling a
 * findFirstOrThrow + update pair, so the tenant check and the read-modify-write
 * pattern live in exactly one place. See docs/decisions.md.
 */
export async function adjustAccount(
  tx: Tx,
  companyId: string,
  accountId: string,
  deltaMinor: number,
) {
  const account = await tx.financialAccount.findFirstOrThrow({
    where: { id: accountId, companyId },
  });
  await tx.financialAccount.update({
    where: { id: account.id },
    data: { currentBalance: account.currentBalance + deltaMinor },
  });
}

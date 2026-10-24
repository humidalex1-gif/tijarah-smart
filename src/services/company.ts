import { prisma, type Tx } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { writeAudit } from "@/services/audit";
import { ServiceError } from "@/services/errors";

export interface UpdateCompanySettingsInput {
  name?: string;
  /**
   * `undefined` = leave unchanged; `""` = clear to null. The other nullable
   * String? fields below share this convention — the caller (the settings
   * form) always submits all five, so an explicit empty string is a
   * deliberate "blank this out", not "field omitted".
   */
  legalName?: string;
  taxNumber?: string;
  phone?: string;
  email?: string;
  address?: string;
  currencyCode?: string;
  defaultTaxRatePct?: number;
  timezone?: string;
  allowNegativeInventory?: boolean;
  defaultLanguage?: string;
}

/** `""` clears a nullable text field to null; a non-empty string passes through; `undefined` leaves it unchanged. */
function clearable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "" ? null : value;
}

/**
 * The currency-lock predicate — shared by the transaction check below and
 * the exported `hasFinancialActivity` (so the settings PAGE can disable the
 * field before the merchant even attempts a locked change). Payment and
 * Expense rows only ever exist once real money has actually moved
 * (`addExpense`/`recordCustomerPayment`/etc. all mutate an account balance
 * in the same transaction that creates the row), so those are counted
 * unconditionally. SalesOrder/PurchaseOrder are NOT: a DRAFT order has
 * posted no receivable/payable and no ledger entry, and cancelSale /
 * cancelPurchaseOrder never un-create a CANCELLED one — counting either
 * would freeze the currency permanently after a single throwaway draft
 * created during setup, with no override. Only CONFIRMED/COMPLETED orders
 * count.
 */
async function hasMovedMoney(client: Tx, companyId: string): Promise<boolean> {
  const [payment, expense, salesOrder, purchaseOrder] = await Promise.all([
    client.payment.findFirst({ where: { companyId }, select: { id: true } }),
    client.expense.findFirst({ where: { companyId }, select: { id: true } }),
    client.salesOrder.findFirst({
      where: { companyId, status: { notIn: ["DRAFT", "CANCELLED"] } },
      select: { id: true },
    }),
    client.purchaseOrder.findFirst({
      where: { companyId, status: { notIn: ["DRAFT", "CANCELLED"] } },
      select: { id: true },
    }),
  ]);
  return !!(payment || expense || salesOrder || purchaseOrder);
}

/**
 * The settings screen's saver — distinct from `completeOnboarding`
 * (src/services/accounts.ts), which only ever writes a handful of fields as
 * part of the one-time onboarding wizard and force-sets
 * `onboardingCompleted`. This never touches `onboardingCompleted`, and
 * covers every field the settings form actually offers. Permission
 * (`settings.edit`) is enforced by the caller's `action()` wrapper, same as
 * every other service — never checked here.
 */
export async function updateCompanySettings(
  ctx: ServiceContext,
  input: UpdateCompanySettingsInput,
) {
  if (
    input.defaultTaxRatePct !== undefined
    && (input.defaultTaxRatePct < 0 || input.defaultTaxRatePct > 10_000)
  ) {
    throw new ServiceError("INVALID_TAX_RATE");
  }

  return prisma.$transaction(async (tx) => {
    // findFirstOrThrow with an explicit companyId filter, not update({where:
    // {id: ctx.companyId}}) directly — same tenant-boundary pattern as every
    // other write in this codebase, and it gives us the pre-update row for
    // the audit's oldValues.
    const before = await tx.company.findFirstOrThrow({ where: { id: ctx.companyId } });

    // Every stored amount is minor units of the company's CURRENT currency —
    // switching it once real financial activity exists silently relabels
    // every historical figure into the new currency rather than converting
    // it. Lock the currency the moment any such activity exists; an early
    // correction (before real activity) is still allowed. Guarded on the
    // value ACTUALLY changing — a no-op save (same code, or omitted) must
    // never run this check at all, load-bearing for a save that also
    // touches other fields on an otherwise-locked company.
    if (input.currencyCode !== undefined && input.currencyCode !== before.currencyCode) {
      if (await hasMovedMoney(tx, ctx.companyId)) {
        throw new ServiceError("CURRENCY_LOCKED");
      }
    }

    const after = await tx.company.update({
      where: { id: before.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.legalName !== undefined ? { legalName: clearable(input.legalName) } : {}),
        ...(input.taxNumber !== undefined ? { taxNumber: clearable(input.taxNumber) } : {}),
        ...(input.phone !== undefined ? { phone: clearable(input.phone) } : {}),
        ...(input.email !== undefined ? { email: clearable(input.email) } : {}),
        ...(input.address !== undefined ? { address: clearable(input.address) } : {}),
        ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        ...(input.defaultTaxRatePct !== undefined ? { defaultTaxRatePct: input.defaultTaxRatePct } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.allowNegativeInventory !== undefined
          ? { allowNegativeInventory: input.allowNegativeInventory } : {}),
        ...(input.defaultLanguage !== undefined ? { defaultLanguage: input.defaultLanguage } : {}),
        // onboardingCompleted is deliberately absent — completeOnboarding
        // owns that field exclusively.
      },
    });

    await writeAudit(tx, ctx, {
      action: "COMPANY_SETTINGS_UPDATED",
      entityType: "Company",
      entityId: after.id,
      oldValues: {
        name: before.name, legalName: before.legalName, taxNumber: before.taxNumber,
        phone: before.phone, email: before.email, address: before.address,
        currencyCode: before.currencyCode, defaultTaxRatePct: before.defaultTaxRatePct,
        timezone: before.timezone, allowNegativeInventory: before.allowNegativeInventory,
        defaultLanguage: before.defaultLanguage,
      },
      newValues: input,
    });

    return after;
  });
}

/**
 * The predicate `updateCompanySettings` itself uses to lock the currency —
 * exported so the settings PAGE can disable the currency field and show an
 * explanatory hint before the merchant even attempts a change that would
 * only fail server-side otherwise. See `hasMovedMoney` above for exactly
 * what counts.
 */
export async function hasFinancialActivity(companyId: string): Promise<boolean> {
  return hasMovedMoney(prisma, companyId);
}

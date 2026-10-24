"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { completeOnboarding } from "@/services/accounts";
import { toMinor } from "@/lib/money";
import { LOCALES } from "@/lib/i18n";
import { ServiceError } from "@/services/errors";
import { prisma } from "@/lib/db";

// Empty/absent -> undefined (field is optional); anything else must parse to
// a finite, non-negative number. Used for openingCash/openingBank so a
// direct POST with garbage ("abc") fails validation here instead of reaching
// toMinor()'s `ServiceError("INVALID_AMOUNT")` guard as an unhandled 500.
const optionalNonNegativeAmount = z.preprocess(
  (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
  z.coerce.number({ error: "errors.INVALID_AMOUNT" })
    .finite("errors.INVALID_AMOUNT")
    .min(0, "errors.INVALID_AMOUNT")
    .optional(),
);

// Every message below is a dictionary KEY, not English text —
// OnboardingForm resolves it through `labels.errors` before it ever reaches
// an Arabic merchant, same convention as products/actions.ts's superRefine
// and the register action's schema.
const schema = z.object({
  companyName: z.string().min(2, "errors.INVALID_NAME"),
  currencyCode: z.string().trim()
    .length(3, "errors.INVALID_CURRENCY_CODE")
    .regex(/^[A-Z]{3}$/i, "errors.INVALID_CURRENCY_CODE")
    .toUpperCase(),
  // Percent (e.g. 15 for 15%), not basis points — converted below. Bounded
  // to a sane 0-100% so a negative or nonsensical rate can't reach
  // Company.defaultTaxRatePct.
  taxRate: z.coerce.number({ error: "errors.INVALID_TAX_RATE" })
    .finite("errors.INVALID_TAX_RATE")
    .min(0, "errors.INVALID_TAX_RATE")
    .max(100, "errors.INVALID_TAX_RATE"),
  warehouseName: z.string().min(1, "errors.INVALID_NAME"),
  openingCash: optionalNonNegativeAmount,
  openingBank: optionalNonNegativeAmount,
  // Same open-redirect reasoning as the login/register actions: this drives
  // the post-submit redirect.
  locale: z.enum(LOCALES),
});

export async function onboardingAction(_prev: unknown, formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  // `fields` lets OnboardingForm surface each bad value next to its own
  // input (see CRITICAL 1 in the Stage 1B review) instead of only the
  // generic banner — same shape as registerAction's return.
  if (!parsed.success) {
    return { error: "errors.generic", fields: parsed.error.flatten().fieldErrors };
  }

  const session = await requireSession().catch(() => null);
  if (!session) redirect(`/${parsed.data.locale}/login`);

  // The JWT is a cache, not authority (docs/decisions.md #2): a stale
  // session can replay this form — or the company can be deleted between
  // page load and submit — after the token is already valid. completeOnboarding
  // does a bare `tx.company.update({ where: { id: ctx.companyId } })`, which
  // throws Prisma's P2025 on a missing row; that's not a ServiceError, so it
  // would otherwise reach the error boundary as an unhandled 500. Treat a
  // missing company the same way page.tsx treats it: unauthenticated.
  const company = await prisma.company.findUnique({ where: { id: session.companyId } });
  if (!company) redirect(`/${parsed.data.locale}/login`);

  // No permission check existed here at all: any authenticated member —
  // including a VIEWER, who holds no create/edit permission whatsoever —
  // could POST this action id directly. Only the OWNER legitimately performs
  // first-time setup (renaming the company, setting currency/tax, funding
  // accounts); re-read the ACTING membership fresh rather than trust the
  // JWT's role claim (docs/decisions.md #2), same pattern as
  // settings/actions.ts's inviteUser OWNER check.
  const membership = await prisma.membership.findFirst({
    where: { userId: session.userId, companyId: session.companyId, status: "ACTIVE" },
    select: { role: true },
  });
  if (membership?.role !== "OWNER") return { error: "errors.FORBIDDEN" };

  try {
    await completeOnboarding(
      { companyId: session.companyId, userId: session.userId },
      {
        companyName: parsed.data.companyName,
        currencyCode: parsed.data.currencyCode,
        defaultTaxRatePct: Math.round(parsed.data.taxRate * 100),
        warehouseName: parsed.data.warehouseName,
        openingCash:
          parsed.data.openingCash !== undefined ? toMinor(parsed.data.openingCash) : undefined,
        openingBank:
          parsed.data.openingBank !== undefined ? toMinor(parsed.data.openingBank) : undefined,
      },
    );
  } catch (error) {
    if (error instanceof ServiceError) return { error: `errors.${error.code}` };
    throw error;
  }

  redirect(`/${parsed.data.locale}/dashboard`);
}

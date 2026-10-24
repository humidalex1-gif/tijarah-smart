"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { prisma } from "@/lib/db";
import { ROLES } from "@/lib/constants";
import { updateCompanySettings } from "@/services/company";
import { inviteUser, setUserPassword } from "@/services/accounts";
import { ServiceError } from "@/services/errors";

// Same "blank -> undefined" convention as every other actions.ts in this app.
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
// Deliberately NOT the emptyToUndefined-preprocessed optionalText above: the
// settings form always submits these five fields, so an explicit "" is the
// merchant clearing the field, not omitting it — updateCompanySettings
// (src/services/company.ts) maps "" to null for each. Blanking `name`,
// `currencyCode`, `defaultTaxRatePct`, or `timezone` is NOT offered the same
// way — those keep the emptyToUndefined convention (a blanked required-ish
// field leaves the prior value alone rather than becoming null/invalid).
const clearableText = z.string().optional();
// Percent (e.g. 15 for 15%), not basis points — converted in the handler,
// same convention as onboarding/actions.ts's identically shaped `taxRate`.
const optionalTaxRatePct = z.preprocess(emptyToUndefined, z.coerce.number().finite().min(0).max(100).optional());
// The form always sets this field to the literal string "true"/"false" (a
// controlled checkbox, never an uncontrolled HTML checkbox whose unchecked
// state omits the field entirely) — see CompanySettingsForm.tsx.
const optionalBoolText = z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional());

export const updateCompanySettingsAction = action({
  permission: "settings.edit",
  schema: z.object({
    name: optionalText,
    legalName: clearableText,
    taxNumber: clearableText,
    phone: clearableText,
    email: clearableText,
    address: clearableText,
    currencyCode: z.preprocess(
      emptyToUndefined,
      z.string().trim().length(3).regex(/^[A-Z]{3}$/i).toUpperCase().optional(),
    ),
    defaultTaxRatePct: optionalTaxRatePct,
    timezone: optionalText,
    allowNegativeInventory: optionalBoolText,
    // No defaultLanguage field: the settings screen's brief field list never
    // included a language control (unlike onboarding, which sets it once at
    // registration from the signup locale — src/services/accounts.ts), and
    // nothing in the app reads Company.defaultLanguage back out to affect
    // rendering. updateCompanySettings still accepts it (matching its
    // original service contract) for a future screen that wires one up;
    // this action just never passes it, so it's always left unchanged here.
  }),
  handler: async (input, ctx) => {
    const company = await updateCompanySettings(ctx, {
      name: input.name,
      legalName: input.legalName,
      taxNumber: input.taxNumber,
      phone: input.phone,
      email: input.email,
      address: input.address,
      currencyCode: input.currencyCode,
      defaultTaxRatePct: input.defaultTaxRatePct !== undefined
        ? Math.round(input.defaultTaxRatePct * 100) : undefined,
      timezone: input.timezone,
      allowNegativeInventory: input.allowNegativeInventory !== undefined
        ? input.allowNegativeInventory === "true" : undefined,
    });
    return { id: company.id };
  },
});

export const inviteUserAction = action({
  permission: "users.manage",
  schema: z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(ROLES),
  }),
  handler: async (input, ctx) => {
    // users.manage alone is not "may create another OWNER" — an ADMIN
    // holding users.manage could otherwise mint a second OWNER account
    // (or hand the role to a compromised login) with no owner-level
    // approval at all. Re-read the ACTING membership's role fresh (same
    // stale-token posture as action()'s own membership re-read, docs/
    // decisions.md #2) rather than trust anything cached.
    if (input.role === "OWNER") {
      const acting = await prisma.membership.findFirst({
        where: { userId: ctx.userId ?? "", companyId: ctx.companyId, status: "ACTIVE" },
      });
      if (acting?.role !== "OWNER") throw new ServiceError("FORBIDDEN");
    }

    const result = await inviteUser(ctx, {
      fullName: input.fullName, email: input.email, password: input.password, role: input.role,
    });
    return result;
  },
});

export const setUserPasswordAction = action({
  permission: "users.manage",
  schema: z.object({
    userId: z.string().min(1),
    newPassword: z.string().min(8),
  }),
  handler: async (input, ctx) => {
    // Never let anyone but the OWNER themself reset the OWNER's password
    // through this admin panel — users.manage (held by ADMIN too) would
    // otherwise let an ADMIN lock the OWNER out of their own account. The
    // `target.userId !== ctx.userId` clause is what makes this "anyone but
    // the OWNER themself" rather than "no one, ever": /settings/team is the
    // ONLY password-setting surface in Stage 1 (no forgot-password route, no
    // self-service change, no profile page), so an unconditional refusal
    // would strand an owner who forgets their own password with zero
    // recovery path — worse than the ADMIN-lockout risk this guards against.
    // Deliberately NOT filtered by status: "ACTIVE" — setUserPassword itself
    // (src/services/accounts.ts) looks the membership up with no status
    // filter, so an INACTIVE target used to resolve to null here (guard
    // silently skipped) while still resolving in the service. Not reachable
    // today (nothing mutates membership status yet) but this must see
    // exactly the row the service will act on.
    const target = await prisma.membership.findFirst({
      where: { userId: input.userId, companyId: ctx.companyId },
    });
    if (target?.role === "OWNER" && target.userId !== ctx.userId) throw new ServiceError("FORBIDDEN");

    await setUserPassword(ctx, input.userId, input.newPassword);
    return { id: input.userId };
  },
});

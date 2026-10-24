"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { saveCredentials, disconnect } from "@/services/salla/connection";
import { buildSallaCostReport } from "@/services/salla/costReport";

/**
 * Both go through `action()` rather than loadAppContext/requirePermission.
 * Those two are PAGE helpers: they redirect, so using them here turns an
 * expired session into a bounce to the login screen with the form silently
 * discarded, instead of an error the screen can show.
 *
 * Neither result ever carries the submitted secret back — a server action's
 * return value crosses to the browser.
 */

/**
 * An empty secret means "keep the stored one". The field renders empty on
 * every visit because the saved secret is never sent to the browser, so
 * reading empty as "clear it" would wipe the secret whenever the owner
 * corrected a typo in the client id.
 */
const keepIfBlank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const saveSallaCredentialsAction = action({
  permission: "settings.edit",
  schema: z.object({
    clientId: z.string().trim().min(1, { message: "errors.SALLA_NOT_CONFIGURED" }),
    clientSecret: z.preprocess(keepIfBlank, z.string().trim().optional()),
  }),
  handler: async (input, ctx) => {
    await saveCredentials(ctx.companyId, input.clientId, input.clientSecret ?? null);
  },
});

export const disconnectSallaAction = action({
  permission: "settings.edit",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    await disconnect(ctx.companyId);
  },
});

/**
 * Reads Salla's catalogue and compares its cost prices against ours.
 *
 * Gated on `finance.view_cost`, not `settings.edit` like its neighbours: the
 * result IS cost data, and a server action's return value crosses to the
 * browser. Every other screen gates costs on this permission and so does this.
 *
 * Writes nothing, to Salla or to us. It reports what a repair would use;
 * `scripts/fix-product-costs.ts` performs one, run by a human, because it has
 * no undo.
 */
export const readSallaCostsAction = action({
  permission: "finance.view_cost",
  schema: z.object({}),
  handler: async (_input, ctx) => buildSallaCostReport(ctx.companyId),
});

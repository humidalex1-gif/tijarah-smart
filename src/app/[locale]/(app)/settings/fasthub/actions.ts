"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { action } from "@/lib/action";
import { saveFastHubCredentials, disconnectFastHub } from "@/services/fasthub/connection";
import { pollFastHub, type PollReport } from "@/services/fasthub/poll";

/**
 * Both go through `action()`, not loadAppContext/requirePermission. Those two
 * are PAGE helpers that redirect, so an expired session would bounce the owner
 * to login and discard the form silently — which is exactly what happened on
 * the first draft of the Salla screen.
 *
 * Neither result ever carries a submitted secret back: a server action's return
 * value crosses to the browser.
 */

/** Empty means "keep the stored one" — no secret field ever renders its value. */
const keepIfBlank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const optionalSecret = z.preprocess(keepIfBlank, z.string().trim().optional());

export const saveFastHubCredentialsAction = action({
  permission: "settings.edit",
  schema: z.object({
    clientId: z.string().trim().min(1, { message: "errors.FASTHUB_NOT_CONFIGURED" }),
    clientSecret: optionalSecret,
    accessToken: optionalSecret,
    refreshToken: optionalSecret,
    webhookSecret: optionalSecret,
  }),
  handler: async (input, ctx) => {
    await saveFastHubCredentials(ctx.companyId, {
      clientId: input.clientId,
      clientSecret: input.clientSecret ?? null,
      accessToken: input.accessToken ?? null,
      refreshToken: input.refreshToken ?? null,
      webhookSecret: input.webhookSecret ?? null,
    });
  },
});

export const disconnectFastHubAction = action({
  permission: "settings.edit",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    await disconnectFastHub(ctx.companyId);
  },
});

/**
 * The manual catch-up poll.
 *
 * The hub code comes from the default warehouse's `code`, because that
 * warehouse IS the Fast Hub hub — the owner can correct it on the warehouses
 * screen without a schema change.
 *
 * The whole report is returned so the screen can SHOW what happened. A sync
 * that reports nothing is how an inert feature shipped unnoticed before.
 */
export const syncFastHubAction = action({
  permission: "settings.edit",
  schema: z.object({}),
  handler: async (_input, ctx): Promise<PollReport> => {
    const warehouse = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: ctx.companyId, isDefault: true },
      select: { id: true, code: true },
    });
    return pollFastHub(ctx.companyId, warehouse.id, warehouse.code ?? "");
  },
});

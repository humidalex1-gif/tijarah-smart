"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor } from "@/lib/money";
import { AD_CHANNELS } from "@/lib/constants";
import { recordAdSpend } from "@/services/adspend";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());

export const recordAdSpendAction = action({
  permission: "adspend.manage",
  schema: z.object({
    channel: z.enum(AD_CHANNELS),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    // Typed in major units by a human; stored in minor units like every other
    // money column in this codebase.
    amount: z.coerce.number().min(0, { message: "errors.ADSPEND_INVALID_AMOUNT" }),
    productId: optionalText,
    campaign: optionalText,
  }),
  handler: async (input, ctx) =>
    recordAdSpend(ctx, {
      channel: input.channel,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amount: toMinor(input.amount),
      // "All products" submits an empty value, which optionalText turns into
      // undefined. Map it to null explicitly so untagged spend is pooled and
      // allocated by revenue on read rather than silently attributed.
      productId: input.productId ?? null,
      campaign: input.campaign ?? null,
    }),
});

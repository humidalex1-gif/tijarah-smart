"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toQty } from "@/lib/money";
import { CLAIM_KINDS } from "@/lib/constants";
import { openClaim } from "@/services/claims";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());

/**
 * Open a claim by hand.
 *
 * Until the Salla sync lands, this is the ONLY way a claim comes into
 * existence — and without it the reconciliation degenerates to a raw
 * difference with nothing to attribute it to. The merchant opens one when they
 * know stock went back or was damaged and the warehouse has not confirmed it.
 *
 * No sourceKey is passed: absence means "manual", which openClaim answers with
 * a freshly generated key so two entries for the same product never collapse
 * into one.
 */
export const openClaimAction = action({
  permission: "reconcile.post",
  schema: z.object({
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    kind: z.enum(CLAIM_KINDS),
    quantity: z.coerce.number().positive({ message: "errors.CLAIM_INVALID_QUANTITY" }),
    notes: optionalText,
  }),
  handler: async (input, ctx) =>
    openClaim(ctx, {
      productId: input.productId,
      warehouseId: input.warehouseId,
      kind: input.kind,
      // The merchant is asserting this themselves; nobody else has told them.
      assertedBy: "MERCHANT",
      quantity: toQty(input.quantity),
      notes: input.notes ?? null,
    }),
});

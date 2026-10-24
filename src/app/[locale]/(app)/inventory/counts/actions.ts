"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toQty } from "@/lib/money";
import {
  createStockCount, recordCount, requestRecount,
  submitForReview, postStockCount, cancelStockCount,
} from "@/services/stockCount";

// Same "blank -> undefined" convention as sales/actions.ts's and
// purchases/actions.ts's identically named helpers (not shared across action
// files today — each actions.ts is self-contained, matching the existing
// repo structure).
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());

/**
 * MANUAL scope's product selection arrives as ONE hidden field holding a
 * JSON array of product ids, not repeated same-name form fields — same
 * rationale as sales/actions.ts's and purchases/actions.ts's `jsonLines`:
 * `action()` builds its raw record with `Object.fromEntries(formData.entries())`,
 * which silently keeps only the LAST value for a repeated key.
 *
 * A bare `JSON.parse` here would let a malformed payload throw a raw
 * SyntaxError that `action()`'s catch-all (`src/lib/action.ts`) turns into
 * the generic "errors.generic" key, telling the merchant nothing about what
 * went wrong with THEIR input specifically. Parsing inside the schema with
 * `ctx.addIssue` attaches a real, translatable dictionary key to the
 * `productIds` field instead, matching every other multi-value field in this
 * codebase. Reuses "errors.INVALID_LINES" rather than minting a new code —
 * the failure mode (a corrupted hidden JSON field) and the merchant-facing
 * remedy ("refresh the page and try again") are identical to `jsonLines`'s.
 */
const jsonProductIds = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "errors.INVALID_LINES" });
    return z.NEVER;
  }
// Bounded so one payload can't force the handler to loop/allocate over an
// unbounded number of ids — 200 is comfortably above any legitimate manual
// selection, matching jsonLines()'s own cap.
}).pipe(z.array(z.string().min(1)).max(200, "errors.TOO_MANY_LINES"));
const optionalProductIds = z.preprocess(emptyToUndefined, jsonProductIds.optional());

export const createStockCountAction = action({
  permission: "inventory.count",
  schema: z.object({
    warehouseId: z.string().min(1),
    scopeType: z.enum(["WAREHOUSE", "CATEGORY", "BRAND", "MANUAL"]),
    categoryId: optionalText,
    brandId: optionalText,
    productIds: optionalProductIds,
    notes: optionalText,
  }),
  handler: async (input, ctx) => {
    const scope =
      input.scopeType === "CATEGORY"
        ? { scopeType: "CATEGORY" as const, categoryId: input.categoryId ?? "" }
        : input.scopeType === "BRAND"
          ? { scopeType: "BRAND" as const, brandId: input.brandId ?? "" }
          : input.scopeType === "MANUAL"
            ? { scopeType: "MANUAL" as const, productIds: input.productIds ?? [] }
            : { scopeType: "WAREHOUSE" as const };

    return createStockCount(ctx, {
      warehouseId: input.warehouseId,
      scope,
      notes: input.notes,
    });
  },
});

export const recordCountAction = action({
  permission: "inventory.count",
  schema: z.object({
    lineId: z.string().min(1),
    countedQty: z.coerce.number({ error: "errors.INVALID_QUANTITY" })
      .finite("errors.INVALID_QUANTITY")
      .min(0, "errors.INVALID_QUANTITY"),
  }),
  handler: async (input, ctx) => recordCount(ctx, {
    lineId: input.lineId,
    countedQty: toQty(input.countedQty),
  }),
});

// Gated on inventory.count_post, not inventory.count — requesting a recount
// is a reviewer's decision, made from the review screen a counter (who only
// holds inventory.count) cannot even see (spec §8).
export const requestRecountAction = action({
  permission: "inventory.count_post",
  schema: z.object({ lineId: z.string().min(1) }),
  handler: async (input, ctx) => requestRecount(ctx, { lineId: input.lineId }),
});

export const submitForReviewAction = action({
  permission: "inventory.count",
  schema: z.object({ sessionId: z.string().min(1) }),
  handler: async (input, ctx) => submitForReview(ctx, { sessionId: input.sessionId }),
});

export const postStockCountAction = action({
  permission: "inventory.count_post",
  schema: z.object({ sessionId: z.string().min(1) }),
  handler: async (input, ctx) => postStockCount(ctx, { sessionId: input.sessionId }),
});

export const cancelStockCountAction = action({
  permission: "inventory.count_post",
  schema: z.object({
    sessionId: z.string().min(1),
    // A dictionary key as the custom message, same convention as
    // sales/actions.ts's and purchases/actions.ts's identical
    // cancel-with-reason actions — action() copies a Zod issue's message
    // verbatim into `state.fields`, so a hand-authored sentence here would
    // show untranslated English to an Arabic merchant.
    reason: z.string().min(1, "errors.REASON_REQUIRED"),
  }),
  handler: async (input, ctx) => cancelStockCount(ctx, {
    sessionId: input.sessionId,
    reason: input.reason,
  }),
});

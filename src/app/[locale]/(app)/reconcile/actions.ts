"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { prisma } from "@/lib/db";
import { postReconcile, previewReconcile } from "@/services/reconcile";
import { syncFastHubInventory } from "@/services/fasthub/poll";

/**
 * The reconciliation lines arrive as ONE hidden field holding a JSON array,
 * not as repeated same-name fields: `action()` builds its raw record with
 * `Object.fromEntries(formData.entries())`, which silently keeps only the LAST
 * value for a repeated key. Same idiom, and the same reason, as `jsonLines` in
 * sales/actions.ts and purchases/actions.ts.
 *
 * Parsing inside the schema with `ctx.addIssue` rather than a bare
 * `JSON.parse` attaches a real dictionary key to the field; a bare parse would
 * throw a SyntaxError that `action()`'s catch-all turns into the generic
 * message, telling the merchant nothing about their own input.
 */
const jsonLines = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "errors.INVALID_LINES" });
    return z.NEVER;
  }
});

const lineSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().nullable().optional(),
  sellable: z.number().int().min(0),
  damaged: z.number().int().min(0).nullable().optional(),
});

/**
 * Fetches what Fast Hub currently reports per SKU, so the owner does not
 * retype figures the system can already read. Returns them; writes nothing.
 *
 * `syncFastHubInventory` is write-free by design — mirroring their numbers
 * into our balances would erase the discrepancy this project exists to expose.
 * The figures land in the same editable inputs the owner types into, so they
 * remain an ASSERTION the owner can overwrite with what a human at Fast Hub
 * actually said, never a fact the system adopted.
 *
 * It cannot fill the damaged box: the inventory endpoint carries
 * available_quantity and quantity_on_hand and no damaged field. Leaving it
 * blank is correct — blank already means "they did not say".
 */
export const fastHubFiguresAction = action({
  permission: "reconcile.post",
  schema: z.object({ warehouseId: z.string().min(1) }),
  handler: async (input, ctx) => {
    // Tenant gate: a foreign warehouse resolves to nothing, never everything.
    //
    // findFirstOrThrow, not findFirst plus a bare `Error("CODE")`. A bare Error
    // is not classified by `action()`, so its code never reaches the client AND
    // `errorCatalog.test.ts` cannot see it — that guard scans only
    // `new ServiceError` and `invalidState`. decisions.md #9 records this exact
    // pattern as a defect Stage 1B retired at three sites. P2025 from here maps
    // to the catalogued `errors.NOT_FOUND`, as ~31 other tenant gates rely on.
    const warehouse = await prisma.warehouse.findFirstOrThrow({
      where: { id: input.warehouseId, companyId: ctx.companyId },
      select: { id: true, code: true },
    });

    const report = await syncFastHubInventory(
      ctx.companyId,
      warehouse.id,
      warehouse.code ?? "",
    );
    return {
      lines: report.lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        sellable: l.sellable,
        onHand: l.onHand,
      })),
      unknownSkus: report.unknownSkus,
    };
  },
});

/**
 * Rehearses the reconciliation and returns the decomposition, writing nothing.
 *
 * The split into settleable, still-claimed and unexplained IS the product of
 * this screen, and it used to come back only after `postReconcile` — which is
 * irreversible. The service was built and tested; only this wiring was absent.
 *
 * Gated identically to the post: a preview reads stock levels and open claim
 * positions, so a role that may not reconcile may not rehearse it either.
 * It takes no `isPhysicalCount` — that flag records how the figures were
 * OBTAINED, which only matters once something is written.
 */
export const previewReconcileAction = action({
  permission: "reconcile.post",
  schema: z.object({
    warehouseId: z.string().min(1),
    asOf: z.coerce.date(),
    lines: jsonLines.pipe(z.array(lineSchema).min(1, { message: "errors.RECONCILE_NO_LINES" })),
  }),
  handler: async (input, ctx) =>
    previewReconcile(ctx, {
      warehouseId: input.warehouseId,
      asOf: input.asOf,
      lines: input.lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId ?? null,
        sellable: l.sellable,
        damaged: l.damaged ?? null,
      })),
    }),
});

export const postReconcileAction = action({
  permission: "reconcile.post",
  schema: z.object({
    warehouseId: z.string().min(1),
    asOf: z.coerce.date(),
    // An HTML checkbox submits nothing when unticked, so absence means false.
    // That is the safe default here: treating an unticked box as a physical
    // count would suppress the caveat on the profit screen.
    isPhysicalCount: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
    lines: jsonLines.pipe(z.array(lineSchema).min(1, { message: "errors.RECONCILE_NO_LINES" })),
  }),
  handler: async (input, ctx) =>
    postReconcile(ctx, {
      warehouseId: input.warehouseId,
      asOf: input.asOf,
      isPhysicalCount: input.isPhysicalCount,
      lines: input.lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId ?? null,
        sellable: l.sellable,
        damaged: l.damaged ?? null,
      })),
    }),
});

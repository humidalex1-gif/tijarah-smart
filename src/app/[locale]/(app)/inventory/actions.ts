"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/constants";
import { toQty, toMinor, toCost } from "@/lib/money";
import {
  receiveStockManual, issueStock, adjustStock, createTransfer, receiveTransfer,
} from "@/services/stock";
import { availableFor } from "@/services/reporting";

// Same "blank -> undefined" convention as products/actions.ts's identically
// named helpers (not shared across action files today — each actions.ts is
// self-contained, matching the existing repo structure).
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());

/**
 * Multi-line inputs (a transfer's product lines, a transfer receipt's
 * settled lines) arrive as ONE hidden field holding a JSON array, not as
 * repeated same-name form fields. `action()` parses with
 * `Object.fromEntries(formData.entries())`, and `Object.fromEntries`
 * silently keeps only the LAST value for a repeated key — every earlier line
 * would be dropped with no error. A single JSON field sidesteps that
 * entirely.
 */
function jsonLines<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.string().transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // A dictionary KEY, not "errors.generic" — the forms below resolve
      // this through `labels.errors` and render it next to the line items
      // instead of leaving a decode failure indistinguishable from any other
      // unexpected error.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "errors.INVALID_LINES" });
      return z.NEVER;
    }
  // Bounded so one payload can't force the handler to loop/allocate over an
  // unbounded number of lines — 200 is comfortably above any legitimate
  // transfer or transfer-receipt line count. A dictionary key here too, for
  // the same reason: Zod's default array-too-long message is hand-authored
  // English and would otherwise leak untranslated to an Arabic merchant.
  }).pipe(z.array(itemSchema).max(200, "errors.TOO_MANY_LINES"));
}

export const receiveStockAction = action({
  permission: "inventory.receive",
  schema: z.object({
    warehouseId: z.string().min(1),
    productId: z.string().min(1),
    quantity: z.coerce.number().finite().positive(),
    // A zero unit cost would create a permanent zero cost basis (the same
    // footgun products/actions.ts's OPENING_PRICE_REQUIRED comment warns
    // about for opening stock) — required and positive here too.
    unitCost: z.coerce.number().finite().positive(),
    notes: optionalText,
  }),
  handler: async (input, ctx) => receiveStockManual(ctx, {
    warehouseId: input.warehouseId,
    productId: input.productId,
    quantity: toQty(input.quantity),
    unitCost: toCost(toMinor(input.unitCost)),
    notes: input.notes,
  }),
});

export const issueStockAction = action({
  permission: "inventory.issue",
  schema: z.object({
    warehouseId: z.string().min(1),
    productId: z.string().min(1),
    quantity: z.coerce.number().finite().positive(),
    reason: z.enum(["INTERNAL_USE", "PROMOTIONAL_USE", "DAMAGED", "LOST"]),
    notes: optionalText,
  }),
  handler: async (input, ctx) => issueStock(ctx, {
    warehouseId: input.warehouseId,
    productId: input.productId,
    quantity: toQty(input.quantity),
    reason: input.reason,
    notes: input.notes,
  }),
});

export const adjustStockAction = action({
  permission: "inventory.adjust",
  schema: z.object({
    warehouseId: z.string().min(1),
    productId: z.string().min(1),
    newQuantity: z.coerce.number().finite().min(0),
    reason: z.string().min(1),
    notes: optionalText,
  }),
  handler: async (input, ctx) => adjustStock(ctx, {
    warehouseId: input.warehouseId,
    productId: input.productId,
    newQuantity: toQty(input.newQuantity),
    reason: input.reason,
    notes: input.notes,
  }),
});

export const createTransferAction = action({
  permission: "inventory.transfer",
  schema: z.object({
    sourceWarehouseId: z.string().min(1),
    destinationWarehouseId: z.string().min(1),
    notes: optionalText,
    linesJson: jsonLines(z.object({
      productId: z.string().min(1),
      quantity: z.number().finite().positive(),
    })),
  }),
  handler: async (input, ctx) => createTransfer(ctx, {
    sourceWarehouseId: input.sourceWarehouseId,
    destinationWarehouseId: input.destinationWarehouseId,
    notes: input.notes,
    lines: input.linesJson.map((line) => ({
      productId: line.productId, quantity: toQty(line.quantity),
    })),
  }),
});

export const receiveTransferAction = action({
  permission: "inventory.transfer",
  schema: z.object({
    transferId: z.string().min(1),
    linesJson: jsonLines(z.object({
      itemId: z.string().min(1),
      receivedQty: z.number().finite().min(0),
      damagedQty: z.number().finite().min(0),
    })),
  }),
  handler: async (input, ctx) => {
    await receiveTransfer(ctx, {
      transferId: input.transferId,
      lines: input.linesJson.map((line) => ({
        itemId: line.itemId,
        receivedQty: toQty(line.receivedQty),
        damagedQty: toQty(line.damagedQty),
      })),
    });
    return { transferId: input.transferId };
  },
});

/**
 * Live read of the quantity available at one warehouse/product combo, for
 * the stock-operation forms' "Available: N" line display and for building
 * the friendly `inventory.insufficient` message client-side — `action()`
 * only ever echoes an `INSUFFICIENT_STOCK` ServiceError's CODE back to the
 * client, never its `details` (the `product`/`available` the service threw
 * with never leave the server), so the form has to already know these values
 * itself before it submits.
 *
 * Deliberately NOT wrapped in `action()`: this is a read, not a mutation —
 * no schema to parse, no permission-denial redirect. It still authenticates
 * and requires `inventory.view`, matching the read helpers' contract in
 * `services/reporting.ts` ("no permission of its own beyond the page's
 * inventory.view").
 */
export async function fetchAvailability(
  warehouseId: string,
  productId: string,
): Promise<number> {
  if (!warehouseId || !productId) return 0;
  let session;
  try {
    session = await requireSession();
  } catch {
    return 0;
  }
  // The JWT's role claim is a display cache and survives a demotion or a
  // deactivation until the token dies (docs/decisions.md #2) — authorize off
  // a fresh Membership row and validate the string against ROLES before it
  // reaches can(), same five lines action.ts uses. Impact here was bounded
  // (every role holds inventory.view) but a DEACTIVATED membership still
  // passed and could enumerate per-warehouse stock for the token's 24h life.
  const membership = await prisma.membership.findFirst({
    where: { userId: session.userId, companyId: session.companyId, status: "ACTIVE" },
    select: { role: true },
  });
  if (!membership || !(ROLES as readonly string[]).includes(membership.role)) return 0;
  if (!can(membership.role as Role, "inventory.view")) return 0;
  return availableFor(session.companyId, warehouseId, productId);
}

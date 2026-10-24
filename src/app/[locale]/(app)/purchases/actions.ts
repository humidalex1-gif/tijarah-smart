"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor, toQty } from "@/lib/money";
import { PURCHASE_COST_TYPES } from "@/lib/constants";
import {
  createPurchaseOrder, confirmPurchaseOrder, receivePurchase, cancelPurchaseOrder,
} from "@/services/purchases";
import { ServiceError } from "@/services/errors";

// Same "blank -> undefined" convention as products/actions.ts's identically
// named helpers (not shared across action files today — each actions.ts is
// self-contained, matching the existing repo structure).
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());

/**
 * Multi-line inputs (a purchase order's product lines and additional costs,
 * a receipt's settled lines) arrive as ONE hidden field holding a JSON
 * array, not repeated same-name form fields — same rationale as
 * inventory/actions.ts's identically named helper: `Object.fromEntries`
 * (which `action()` uses to build its raw record) silently keeps only the
 * LAST value for a repeated key, dropping every earlier line with no error.
 */
function jsonLines<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.string().transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // A dictionary KEY, not "errors.generic" — resolved through the
      // form's own `labels.errors` map, same as every other action error.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "errors.INVALID_LINES" });
      return z.NEVER;
    }
  // Bounded so one payload can't force the handler to loop/allocate over an
  // unbounded number of lines — 200 is comfortably above any legitimate
  // order/receipt line count.
  }).pipe(z.array(itemSchema).max(200, "errors.TOO_MANY_LINES"));
}

export const createPurchaseOrderAction = action({
  permission: "purchases.create",
  schema: z.object({
    supplierId: z.string().min(1),
    warehouseId: z.string().min(1),
    orderDate: optionalDate,
    expectedDate: optionalDate,
    // Exactly the four methods createPurchaseOrder actually accepts — MANUAL
    // is a member of ALLOCATION_METHODS but createPurchaseOrder rejects it
    // with MANUAL_ALLOCATION_NOT_SUPPORTED until Stage 2, so it is excluded
    // from this enum (and from the form's <select>) rather than accepted
    // here and rejected server-side.
    allocationMethod: z.enum(["QUANTITY", "VALUE", "WEIGHT", "EQUAL"]).optional(),
    notes: optionalText,
    linesJson: jsonLines(z.object({
      productId: z.string().min(1),
      variantId: optionalText,
      orderedQty: z.number().finite().positive(),
      unitPrice: z.number().finite().min(0),
      discountAmount: z.number().finite().min(0).optional(),
      // Percentage points (0-100); converted to basis points below, matching
      // products/actions.ts's identically shaped `taxRate` field.
      taxRatePct: z.number().finite().min(0).max(100).optional(),
    })),
    additionalCostsJson: jsonLines(z.object({
      costType: z.enum(PURCHASE_COST_TYPES),
      description: optionalText,
      amount: z.number().finite().min(0),
    })),
  }),
  handler: async (input, ctx) => {
    const result = await createPurchaseOrder(ctx, {
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      orderDate: input.orderDate,
      expectedDate: input.expectedDate ?? null,
      allocationMethod: input.allocationMethod,
      notes: input.notes,
      items: input.linesJson.map((line) => ({
        productId: line.productId,
        variantId: line.variantId ?? null,
        orderedQty: toQty(line.orderedQty),
        unitPrice: toMinor(line.unitPrice),
        discountAmount: line.discountAmount !== undefined ? toMinor(line.discountAmount) : undefined,
        taxRatePct: line.taxRatePct !== undefined ? Math.round(line.taxRatePct * 100) : undefined,
      })),
      additionalCosts: input.additionalCostsJson.map((cost) => ({
        costType: cost.costType,
        description: cost.description,
        amount: toMinor(cost.amount),
      })),
    });
    return result;
  },
});

export const confirmPurchaseOrderAction = action({
  permission: "purchases.confirm",
  schema: z.object({ purchaseOrderId: z.string().min(1) }),
  handler: async (input, ctx) => {
    await confirmPurchaseOrder(ctx, input.purchaseOrderId);
    return { id: input.purchaseOrderId };
  },
});

export const receivePurchaseAction = action({
  permission: "purchases.receive",
  schema: z.object({
    purchaseOrderId: z.string().min(1),
    receivedDate: optionalDate,
    notes: optionalText,
    linesJson: jsonLines(z.object({
      purchaseOrderItemId: z.string().min(1),
      acceptedQty: z.number().finite().min(0),
      damagedQty: z.number().finite().min(0).optional(),
    })),
  }),
  handler: async (input, ctx) => {
    // Every ordered item renders one row in the receiving form regardless of
    // whether the merchant is actually receiving anything against it this
    // trip — filter those zero-quantity rows out here rather than forwarding
    // them, since receivePurchase throws EMPTY_RECEIPT_LINE for any line
    // whose accepted+damaged sums to zero.
    const lines = input.linesJson
      .filter((line) => line.acceptedQty > 0 || (line.damagedQty ?? 0) > 0)
      .map((line) => ({
        purchaseOrderItemId: line.purchaseOrderItemId,
        acceptedQty: toQty(line.acceptedQty),
        damagedQty: line.damagedQty !== undefined ? toQty(line.damagedQty) : undefined,
      }));
    if (lines.length === 0) throw new ServiceError("NO_LINES");

    const receipt = await receivePurchase(ctx, {
      purchaseOrderId: input.purchaseOrderId,
      receivedDate: input.receivedDate,
      notes: input.notes,
      lines,
    });
    return receipt;
  },
});

export const cancelPurchaseOrderAction = action({
  permission: "purchases.cancel",
  schema: z.object({
    purchaseOrderId: z.string().min(1),
    // A dictionary key as the custom message, same convention as jsonLines'
    // own `.max(200, "errors.TOO_MANY_LINES")` immediately above — action()
    // copies a Zod issue's message verbatim into `state.fields`, so a
    // hand-authored sentence here would show untranslated English to an
    // Arabic merchant.
    reason: z.string().min(1, "errors.REASON_REQUIRED"),
  }),
  handler: async (input, ctx) => {
    await cancelPurchaseOrder(ctx, input.purchaseOrderId, input.reason);
    return { id: input.purchaseOrderId };
  },
});

// recordSupplierPaymentAction deliberately does NOT live here: it used to be
// duplicated in this file with a bare "payments.create" gate (missing the
// "purchases.view" AND-permission the finance/actions.ts copy carries), so a
// SALES_EMPLOYEE — who holds payments.create but not purchases.view — could
// reach an uncapped supplier payment through this copy alone. Deleting the
// duplicate and importing the single hardened action from finance/actions.ts
// (see PurchaseDetailActions.tsx) removes the drift risk entirely instead of
// requiring the two gates to be kept in sync by hand.

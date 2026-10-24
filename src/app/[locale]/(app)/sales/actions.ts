"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor, toQty } from "@/lib/money";
import { ORDER_COST_TYPES, SALES_CHANNELS, RETURN_CONDITIONS } from "@/lib/constants";
import { createSalesOrder, confirmSale, cancelSale, processReturn } from "@/services/sales";
import { ServiceError } from "@/services/errors";

// Same "blank -> undefined" convention as purchases/actions.ts's identically
// named helpers (not shared across action files today — each actions.ts is
// self-contained, matching the existing repo structure).
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const optionalAmount = z.preprocess(emptyToUndefined, z.coerce.number().finite().min(0).optional());

/**
 * Multi-line inputs (a sale's product lines and order costs, a return's
 * lines) arrive as ONE hidden field holding a JSON array, not repeated
 * same-name form fields — identical rationale to purchases/actions.ts's
 * `jsonLines`: `Object.fromEntries` (which `action()` uses to build its raw
 * record) silently keeps only the LAST value for a repeated key.
 */
function jsonLines<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.string().transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "errors.INVALID_LINES" });
      return z.NEVER;
    }
  }).pipe(z.array(itemSchema).max(200, "errors.TOO_MANY_LINES"));
}

/**
 * Creates the draft sales order AND immediately confirms it (posting stock,
 * the receivable, and any payment) in one submit — the create-sale form has
 * no separate "confirm" step of its own (unlike purchases, which stages
 * create -> confirm -> receive across visits). If `confirmSale` throws (most
 * commonly INSUFFICIENT_STOCK), the DRAFT row created a moment earlier is
 * left in place rather than rolled back: nothing in the posting engine
 * discards a draft (no `discardDraftSale` this stage), and a stranded draft
 * "accumulates harmlessly" by design — see docs/decisions.md and the Task 8
 * brief. The merchant sees the error and can retry with corrected input,
 * which creates a SEPARATE draft; the abandoned one just sits on the list
 * filtered by status=DRAFT.
 */
export const createSalesOrderAction = action({
  // sales.create alone understates what this handler actually does: the
  // no-separate-confirm-step design above means a single submit also posts
  // any payment entered on the form (via confirmSale -> recordCustomerPayment
  // territory), so a role that can create a sale but not record a payment
  // must not reach this. Declaring both is currently a no-op — every role
  // holding sales.create (OWNER, ADMIN, SALES_EMPLOYEE) also holds
  // payments.create per the Stage 1 matrix (src/lib/permissions.ts) — but it
  // stops that alignment from being an accident this action silently depends
  // on.
  permission: ["sales.create", "payments.create"],
  schema: z.object({
    customerId: optionalText,
    warehouseId: z.string().min(1),
    channel: z.enum(SALES_CHANNELS).optional(),
    orderDate: optionalDate,
    shippingCharged: optionalAmount,
    notes: optionalText,
    linesJson: jsonLines(z.object({
      productId: z.string().min(1),
      variantId: optionalText,
      quantity: z.number().finite().positive(),
      unitPrice: z.number().finite().min(0),
      discountAmount: z.number().finite().min(0).optional(),
      taxRatePct: z.number().finite().min(0).max(100).optional(),
    })),
    costsJson: jsonLines(z.object({
      costType: z.enum(ORDER_COST_TYPES),
      description: optionalText,
      amount: z.number().finite().min(0),
    })),
    paidAmount: optionalAmount,
    accountId: optionalText,
  }),
  handler: async (input, ctx) => {
    const { salesOrderId, salesOrderNumber } = await createSalesOrder(ctx, {
      customerId: input.customerId,
      warehouseId: input.warehouseId,
      channel: input.channel,
      orderDate: input.orderDate,
      shippingCharged: input.shippingCharged !== undefined ? toMinor(input.shippingCharged) : undefined,
      notes: input.notes,
      items: input.linesJson.map((line) => ({
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantity: toQty(line.quantity),
        unitPrice: toMinor(line.unitPrice),
        discountAmount: line.discountAmount !== undefined ? toMinor(line.discountAmount) : undefined,
        // createSalesOrder's `taxRatePct` is actually basis points (applyPct's
        // "hundredths of a percent" convention — 15% => 1500), despite the
        // percentage-points (0-100) value the form/schema collect. Same
        // conversion as purchases/actions.ts's identically named field.
        taxRatePct: line.taxRatePct !== undefined ? Math.round(line.taxRatePct * 100) : undefined,
      })),
      costs: input.costsJson.map((cost) => ({
        costType: cost.costType,
        description: cost.description,
        amount: toMinor(cost.amount),
      })),
    });

    const paidAmount = input.paidAmount !== undefined ? toMinor(input.paidAmount) : 0;
    const posted = await confirmSale(ctx, {
      salesOrderId,
      paidAmount,
      accountId: paidAmount > 0 ? input.accountId : undefined,
    });
    return { salesOrderId, salesOrderNumber, ...posted };
  },
});

export const cancelSaleAction = action({
  permission: "sales.cancel",
  schema: z.object({
    salesOrderId: z.string().min(1),
    // A dictionary key as the custom message, same convention as jsonLines'
    // own `.max(200, ...)` above — action() copies a Zod issue's message
    // verbatim into `state.fields`, so a hand-authored sentence here would
    // show untranslated English to an Arabic merchant.
    reason: z.string().min(1, "errors.REASON_REQUIRED"),
  }),
  handler: async (input, ctx) => {
    await cancelSale(ctx, { salesOrderId: input.salesOrderId, reason: input.reason });
    return { id: input.salesOrderId };
  },
});

export const processReturnAction = action({
  permission: "sales.return",
  schema: z.object({
    salesOrderId: z.string().min(1),
    reason: optionalText,
    refundAccountId: optionalText,
    linesJson: jsonLines(z.object({
      salesOrderItemId: z.string().min(1),
      quantity: z.number().finite().min(0),
      condition: z.enum(RETURN_CONDITIONS),
      warehouseId: optionalText,
      refundAmount: z.number().finite().min(0),
    })),
  }),
  handler: async (input, ctx) => {
    // Every sold item renders one row on the return form regardless of
    // whether the merchant is actually returning any of it this trip —
    // filter zero-quantity rows out here (processReturn itself rejects a
    // zero/negative quantity with QUANTITY_MUST_BE_POSITIVE) and send each
    // item at most once, matching receivePurchaseAction's identical filter.
    const lines = input.linesJson
      .filter((line) => line.quantity > 0)
      .map((line) => ({
        salesOrderItemId: line.salesOrderItemId,
        quantity: toQty(line.quantity),
        condition: line.condition,
        warehouseId: line.warehouseId,
        refundAmount: toMinor(line.refundAmount),
      }));
    if (lines.length === 0) throw new ServiceError("NO_LINES");

    return processReturn(ctx, {
      salesOrderId: input.salesOrderId,
      reason: input.reason,
      refundAccountId: input.refundAccountId,
      items: lines,
    });
  },
});

// recordCustomerPaymentAction deliberately does NOT live here. It is defined
// once, in finance/actions.ts, and SaleDetailActions.tsx imports it from
// there. A second copy in this file would be a second independently
// addressable endpoint that happens to look identical today — exactly the
// shape that produced the recordSupplierPaymentAction escalation, where a
// hardening fix landed in one of two copies and the other let a
// SALES_EMPLOYEE post an uncapped supplier payment. See actions.test.ts.

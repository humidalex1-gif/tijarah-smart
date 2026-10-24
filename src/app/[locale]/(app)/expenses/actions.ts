"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor } from "@/lib/money";
import { addExpense, cancelExpense } from "@/services/expenses";
import { withAttachment } from "@/lib/attachOnCreate";

// Same "blank -> undefined" convention as every other actions.ts in this app
// (each file is self-contained, not shared across routes).
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());

export const addExpenseAction = action({
  permission: "expenses.create",
  schema: z.object({
    categoryId: z.string().min(1),
    accountId: z.string().min(1),
    supplierId: optionalText,
    warehouseId: optionalText,
    expenseDate: optionalDate,
    description: z.string().min(1),
    amount: z.coerce.number().finite().positive(),
    // Not `.min(0)` here: a negative value is left for addExpense's own
    // INVALID_TAX_AMOUNT guard (src/services/expenses.ts) so it surfaces as
    // that specific error code, not a generic Zod validation message.
    taxAmount: z.coerce.number().finite().optional(),
    notes: optionalText,
    // The invoice behind the expense, uploaded WITH it. A second step somebody
    // has to remember is a step that does not happen.
    file: z.instanceof(File).optional(),
  }),
  handler: async (input, ctx) => withAttachment(ctx, {
    file: input.file,
    entityType: "EXPENSE",
    create: async () => {
      const created = await addExpense(ctx, {
        categoryId: input.categoryId,
        accountId: input.accountId,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        expenseDate: input.expenseDate,
        description: input.description,
        amount: toMinor(input.amount),
        taxAmount: input.taxAmount !== undefined ? toMinor(input.taxAmount) : undefined,
        notes: input.notes,
      });
      // addExpense answers with `expenseId`; withAttachment joins on `id`.
      return { ...created, id: created.expenseId };
    },
  }),
});

export const cancelExpenseAction = action({
  permission: "expenses.cancel",
  schema: z.object({
    expenseId: z.string().min(1),
    // A dictionary key as the custom message — action() copies a Zod issue's
    // message verbatim into state.fields, so a hand-authored sentence here
    // would show untranslated English to an Arabic merchant (same convention
    // as purchases/actions.ts's cancelPurchaseOrderAction).
    reason: z.string().min(1, "errors.REASON_REQUIRED"),
  }),
  handler: async (input, ctx) => {
    await cancelExpense(ctx, input.expenseId, input.reason);
    return { id: input.expenseId };
  },
});

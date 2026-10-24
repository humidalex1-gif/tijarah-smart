"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor } from "@/lib/money";
import { createAccount } from "@/services/accounts";
import { recordCustomerPayment, recordSupplierPayment, transferBetweenAccounts } from "@/services/payments";
import { withAttachment } from "@/lib/attachOnCreate";

// Same "blank -> undefined" convention as every other actions.ts in this app.
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());

export const createAccountAction = action({
  permission: "finance.manage_accounts",
  schema: z.object({
    name: z.string().min(1),
    accountType: z.enum(["CASH", "BANK"]),
    openingBalance: z.coerce.number().finite().optional(),
  }),
  handler: async (input, ctx) => {
    const account = await createAccount(ctx, {
      name: input.name,
      accountType: input.accountType,
      openingBalance: input.openingBalance !== undefined ? toMinor(input.openingBalance) : undefined,
    });
    return { id: account.id };
  },
});

export const recordCustomerPaymentAction = action({
  permission: "payments.create",
  schema: z.object({
    customerId: z.string().min(1),
    salesOrderId: optionalText,
    accountId: z.string().min(1),
    amount: z.coerce.number().finite().positive(),
    paymentDate: optionalDate,
    referenceNumber: optionalText,
    notes: optionalText,
    /** The receipt or transfer confirmation behind the payment. */
    file: z.instanceof(File).optional(),
  }),
  handler: async (input, ctx) => withAttachment(ctx, {
    file: input.file,
    entityType: "PAYMENT",
    create: async () => {
      const created = await recordCustomerPayment(ctx, {
        customerId: input.customerId,
        salesOrderId: input.salesOrderId,
        accountId: input.accountId,
        amount: toMinor(input.amount),
        paymentDate: input.paymentDate,
        referenceNumber: input.referenceNumber,
        notes: input.notes,
      });
      return { ...created, id: created.paymentId };
    },
  }),
});

export const recordSupplierPaymentAction = action({
  // payments.create alone is not enough: this handler reads/uses supplier
  // and PO data (paidAmount, grandTotal, additionalCostTotal), so a role
  // without purchases.view must never reach it — a SALES_EMPLOYEE holds
  // payments.create (for customer payments on /sales/[id]) but not
  // purchases.view, and must not be able to record a supplier payment via a
  // raw POST even with the tab hidden client-side (see PaymentForm.tsx).
  permission: ["payments.create", "purchases.view"],
  schema: z.object({
    supplierId: z.string().min(1),
    purchaseOrderId: optionalText,
    accountId: z.string().min(1),
    amount: z.coerce.number().finite().positive(),
    paymentDate: optionalDate,
    referenceNumber: optionalText,
    notes: optionalText,
    file: z.instanceof(File).optional(),
  }),
  handler: async (input, ctx) => withAttachment(ctx, {
    file: input.file,
    entityType: "PAYMENT",
    create: async () => {
      const created = await recordSupplierPayment(ctx, {
        supplierId: input.supplierId,
        purchaseOrderId: input.purchaseOrderId,
        accountId: input.accountId,
        amount: toMinor(input.amount),
        paymentDate: input.paymentDate,
        referenceNumber: input.referenceNumber,
        notes: input.notes,
      });
      return { ...created, id: created.paymentId };
    },
  }),
});

export const transferBetweenAccountsAction = action({
  // Moving money between the company's own accounts is a finance-management
  // capability, not a generic "record a payment" one — gate it on
  // finance.manage_accounts too, so a payments.create-only role (e.g.
  // SALES_EMPLOYEE) cannot move money between accounts via a raw POST even
  // with the tab hidden client-side (see PaymentForm.tsx).
  permission: ["payments.create", "finance.manage_accounts"],
  schema: z.object({
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    amount: z.coerce.number().finite().positive(),
    notes: optionalText,
  }),
  handler: async (input, ctx) => transferBetweenAccounts(ctx, {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: toMinor(input.amount),
    notes: input.notes,
  }),
});

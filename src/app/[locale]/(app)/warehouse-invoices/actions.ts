"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { action } from "@/lib/action";
import { saveUpload, readUpload, deleteUpload } from "@/lib/uploads";
import { parseFastHubInvoice } from "@/services/warehouseInvoice/parse";
import { verifyWarehouseInvoice } from "@/services/warehouseInvoice/verify";
import { postWarehouseInvoice } from "@/services/warehouseInvoice/post";
import { invoiceNumberFromFileName } from "@/services/warehouseInvoice/invoiceFiles";

/**
 * Two steps on purpose: reading the file tells the owner what it says, and a
 * separate confirmation posts it. Nothing about an invoice is charged to an
 * order because a file was dropped on a page.
 *
 * The confirm step re-reads and re-parses the stored file rather than trusting
 * anything the browser sends back. A preview round-trip through the client is
 * a preview the client could edit.
 *
 * Both need `expenses.create` (storage becomes an expense) AND `sales.edit`
 * (the fees change orders' profit). A role holding only one of them must be
 * refused, or posting an invoice quietly grants the other.
 */

const PERMISSIONS = ["expenses.create", "sales.edit"] as const;

export const previewWarehouseInvoiceAction = action({
  permission: [...PERMISSIONS],
  schema: z.object({
    file: z.instanceof(File),
    /** Fast Hub's PDF. Kept as the invoice document; never parsed. */
    document: z.instanceof(File).optional(),
  }),
  handler: async (input, ctx) => {
    // Stored before parsing: if the parse throws, the document the owner
    // uploaded is still on record, and its error message can be about the
    // file they can see rather than one that vanished.
    const attachment = await saveUpload(ctx, {
      file: input.file, entityType: "WAREHOUSE_INVOICE", entityId: "",
    });
    const document = input.document
      ? await saveUpload(ctx, {
        file: input.document, entityType: "WAREHOUSE_INVOICE", entityId: "",
      })
      : null;

    try {
      const parsed = await parseFastHubInvoice((await readUpload(ctx, attachment.id)).bytes);
      const verified = await verifyWarehouseInvoice(ctx, parsed);
      return {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        documentAttachmentId: document?.id ?? null,
        documentFileName: document?.fileName ?? null,
        // Read from the PDF's NAME, not its contents — that text layer decodes
        // digits to `6 7 8 9 : ;`. Null when the name does not announce one, so
        // the client falls back to the date and the owner types the number.
        suggestedInvoiceNumber: document ? invoiceNumberFromFileName(document.fileName) : null,
        invoiceDate: verified.parsed.invoiceDate,
        subtotal: verified.parsed.subtotal,
        taxAmount: verified.parsed.taxAmount,
        total: verified.parsed.total,
        totals: verified.totals,
        issues: verified.issues,
        unbilled: verified.unbilled,
        orders: verified.orders.map((o) => ({
          ref: o.line.externalOrderRef,
          salesOrderNumber: o.salesOrderNumber,
          matched: o.salesOrderId !== null,
          packagingFee: o.line.packagingFee,
          handlingFee: o.line.handlingFee,
          shippingFee: o.line.shippingFee,
          extraPieceFee: o.line.extraPieceFee,
          total: o.line.totalBeforeTax,
        })),
        storage: verified.storage,
      };
    } catch (error) {
      // An unreadable upload leaves nothing behind. Keeping it would fill the
      // uploads directory with files attached to no invoice and no expense.
      // Both halves go, including the PDF that was never at fault — it was
      // stored for an invoice that will not exist.
      await deleteUpload(ctx, attachment.id);
      if (document) await deleteUpload(ctx, document.id);
      throw error;
    }
  },
});

export const postWarehouseInvoiceAction = action({
  permission: [...PERMISSIONS],
  schema: z.object({
    attachmentId: z.string().min(1),
    documentAttachmentId: z.string().optional(),
    invoiceNumber: z.string().min(1),
    expenseCategoryId: z.string().min(1),
    expenseAccountId: z.string().min(1),
  }),
  handler: async (input, ctx) => {
    const parsed = await parseFastHubInvoice((await readUpload(ctx, input.attachmentId)).bytes);
    const verified = await verifyWarehouseInvoice(ctx, parsed);

    const result = await postWarehouseInvoice(ctx, {
      verified,
      invoiceNumber: input.invoiceNumber,
      expenseCategoryId: input.expenseCategoryId,
      expenseAccountId: input.expenseAccountId,
      attachmentId: input.attachmentId,
      documentAttachmentId: input.documentAttachmentId ?? null,
    });

    revalidatePath("/[locale]/warehouse-invoices", "page");
    revalidatePath("/[locale]/expenses", "page");
    return result;
  },
});

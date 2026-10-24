"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { action } from "@/lib/action";
import { saveUpload, deleteUpload } from "@/lib/uploads";
import { notFound } from "@/services/errors";

/**
 * Documents hung off an expense.
 *
 * The expense is re-read under this company before anything is written, so an
 * id from another tenant attaches nothing — the attachment row would otherwise
 * be created with a foreign `entityId` and become visible on their screen.
 */

export const attachToExpenseAction = action({
  permission: "expenses.edit",
  schema: z.object({ expenseId: z.string().min(1), file: z.instanceof(File) }),
  handler: async (input, ctx) => {
    const expense = await prisma.expense.findFirst({
      where: { id: input.expenseId, companyId: ctx.companyId },
      select: { id: true },
    });
    if (!expense) throw notFound("Expense");

    const saved = await saveUpload(ctx, {
      file: input.file, entityType: "EXPENSE", entityId: expense.id,
    });
    revalidatePath("/[locale]/expenses/[id]", "page");
    return saved;
  },
});

export const removeExpenseAttachmentAction = action({
  permission: "expenses.edit",
  schema: z.object({ attachmentId: z.string().min(1) }),
  handler: async (input, ctx) => {
    // deleteUpload scopes to the company itself and is a no-op otherwise, so
    // a foreign id removes nothing rather than throwing something that tells
    // the caller the id was real.
    await deleteUpload(ctx, input.attachmentId);
    revalidatePath("/[locale]/expenses/[id]", "page");
    return { removed: true };
  },
});

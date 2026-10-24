import type { ServiceContext } from "@/services/context";
import { saveUpload, deleteUpload } from "@/lib/uploads";

/**
 * Attaches a document to a record that does not exist yet.
 *
 * The order matters, and it is the opposite of the obvious one. The file is
 * validated and written FIRST, then the record is created, then the two are
 * joined — so a rejected file type fails before an expense exists, rather than
 * after, leaving the owner with a saved expense and an error about a document
 * they can no longer attach from that screen.
 *
 * If the record then fails to create, the orphan is removed. Nothing is left
 * in the uploads directory pointing at nothing.
 */
export async function withAttachment<T extends { id: string }>(
  ctx: ServiceContext,
  input: {
    file: File | undefined;
    entityType: "EXPENSE" | "PAYMENT" | "WAREHOUSE_INVOICE";
    create: () => Promise<T>;
  },
): Promise<T & { attachmentId?: string }> {
  if (!input.file || input.file.size === 0) return input.create();

  const saved = await saveUpload(ctx, {
    file: input.file,
    entityType: input.entityType,
    // Filled in below. Empty means "uploaded, not yet owned by anything", and
    // `listAttachments` never matches it, so a stranded row is invisible
    // rather than misfiled.
    entityId: "",
  });

  let created: T;
  try {
    created = await input.create();
  } catch (error) {
    await deleteUpload(ctx, saved.id);
    throw error;
  }

  await reattach(ctx, saved.id, input.entityType, created.id);
  return { ...created, attachmentId: saved.id };
}

async function reattach(
  ctx: ServiceContext,
  attachmentId: string,
  entityType: string,
  entityId: string,
) {
  const { prisma } = await import("@/lib/db");
  await prisma.attachment.updateMany({
    // Scoped to the company as well as the id: `updateMany` with an id alone
    // would be a cross-tenant write waiting to happen.
    where: { id: attachmentId, companyId: ctx.companyId },
    data: { entityType, entityId },
  });
}

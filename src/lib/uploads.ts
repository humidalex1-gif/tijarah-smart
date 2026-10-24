import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { invalidState } from "@/services/errors";

/**
 * Uploaded documents: bytes on disk, a pointer in the database.
 *
 * Blobs stay out of SQLite deliberately. The nightly backup copies the whole
 * database file, and scanned invoices inside it would grow that copy — and the
 * time every backup takes — without bound. `deploy/backup-db.cjs` archives
 * this directory alongside instead.
 */

/**
 * Read on every call, not once at import. Module-load capture meant a
 * deployment that set UPLOAD_DIR after the module was first required kept
 * writing to the default — and the test that inspects the directory caught it.
 * Resolves under /opt/tijarah on the server, which systemd already grants.
 */
const uploadDir = () => process.env.UPLOAD_DIR ?? path.join(process.cwd(), "data", "uploads");

/** 20 MB. Their invoices are ~12 KB; this is for scans, not for videos. */
const MAX_BYTES = 20 * 1024 * 1024;

const ALLOWED = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.ms-excel", ".xls"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

export type StoredAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export async function saveUpload(
  ctx: ServiceContext,
  input: {
    file: File;
    entityType: "EXPENSE" | "PAYMENT" | "WAREHOUSE_INVOICE";
    /** Empty while the owner is still deciding; set when the record exists. */
    entityId: string;
  },
): Promise<StoredAttachment> {
  const { file } = input;
  if (file.size === 0) throw invalidState("UPLOAD_EMPTY");
  if (file.size > MAX_BYTES) {
    throw invalidState("UPLOAD_TOO_LARGE", { limitMb: MAX_BYTES / 1024 / 1024 });
  }

  const extension = ALLOWED.get(file.type);
  if (!extension) throw invalidState("UPLOAD_TYPE_NOT_ALLOWED", { type: file.type });

  // Generated, never derived from the uploaded name. A filename is attacker
  // input: "../../.env" or a duplicate of somebody else's document would
  // otherwise escape this directory or overwrite what is already in it.
  const storedName = `${randomUUID()}${extension}`;

  await mkdir(uploadDir(), { recursive: true });
  await writeFile(path.join(uploadDir(), storedName), Buffer.from(await file.arrayBuffer()));

  const row = await prisma.attachment.create({
    data: {
      companyId: ctx.companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      // Kept for display only. Stripped of any path so a name like
      // "reports/july.pdf" cannot read as a directory anywhere downstream.
      fileName: path.basename(file.name).slice(0, 200),
      storedName,
      mimeType: file.type,
      sizeBytes: file.size,
      uploadedById: ctx.userId,
    },
  });

  return { id: row.id, fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes };
}

/**
 * Reads a stored file back.
 *
 * The path is rebuilt from `storedName` on a row that had to match this
 * company — the caller never supplies a path, so there is nothing to traverse.
 */
export async function readUpload(
  ctx: ServiceContext,
  attachmentId: string,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string; entityType: string }> {
  const row = await prisma.attachment.findFirstOrThrow({
    where: { id: attachmentId, companyId: ctx.companyId },
  });
  const bytes = await readFile(path.join(uploadDir(), row.storedName));
  return { bytes, fileName: row.fileName, mimeType: row.mimeType, entityType: row.entityType };
}

export async function listAttachments(
  ctx: ServiceContext,
  entityType: string,
  entityId: string,
): Promise<StoredAttachment[]> {
  const rows = await prisma.attachment.findMany({
    where: { companyId: ctx.companyId, entityType, entityId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes,
  }));
}

/** Removes the row and the bytes. A missing file is not an error here. */
export async function deleteUpload(ctx: ServiceContext, attachmentId: string): Promise<void> {
  const row = await prisma.attachment.findFirst({
    where: { id: attachmentId, companyId: ctx.companyId },
  });
  if (!row) return;
  await prisma.attachment.delete({ where: { id: row.id } });
  try {
    await unlink(path.join(uploadDir(), row.storedName));
  } catch {
    // The row is what makes the file reachable; an orphaned byte on disk is
    // tidier to leave than to fail a delete over.
  }
}

import type { Tx } from "@/lib/db";
import type { ServiceContext } from "@/services/context";

export async function writeAudit(
  tx: Tx,
  ctx: ServiceContext,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    oldValues?: unknown;
    newValues?: unknown;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      oldValues: entry.oldValues === undefined ? null : JSON.stringify(entry.oldValues),
      newValues: entry.newValues === undefined ? null : JSON.stringify(entry.newValues),
    },
  });
}

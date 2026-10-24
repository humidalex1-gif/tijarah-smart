import type { Tx } from "@/lib/db";

/**
 * Sequential per-company document numbers, e.g. PO-0001.
 * Must be called inside the same transaction as the document it numbers.
 */
export async function nextNumber(tx: Tx, companyId: string, prefix: string): Promise<string> {
  const existing = await tx.numberSequence.findUnique({
    where: { companyId_prefix: { companyId, prefix } },
  });

  if (!existing) {
    await tx.numberSequence.create({ data: { companyId, prefix, nextValue: 2 } });
    return `${prefix}-0001`;
  }

  const value = existing.nextValue;
  await tx.numberSequence.update({
    where: { id: existing.id },
    data: { nextValue: value + 1 },
  });
  return `${prefix}-${String(value).padStart(4, "0")}`;
}

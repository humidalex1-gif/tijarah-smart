import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { writeAudit } from "@/services/audit";
import { ServiceError } from "@/services/errors";

export interface WarehouseWriteInput {
  name?: string;
  code?: string;
  city?: string | null;
  isDefault?: boolean;
}

/**
 * Permission enforcement (`warehouses.create`) lives in the server action
 * wrapper (`src/lib/action.ts`'s `action()`), not here — same division of
 * responsibility as `createCategory`/`createBrand` in `src/services/catalog.ts`.
 */
export async function createWarehouse(
  ctx: ServiceContext,
  input: { name: string; code: string; city?: string | null; isDefault?: boolean },
) {
  return prisma.$transaction(async (tx) => {
    // Tenant-scoped duplicate check, not a bare unique-constraint catch: the
    // schema's `@@unique([companyId, code])` would surface as an unhandled
    // Prisma P2002 through action()'s generic branch (only P2025 is mapped),
    // rendering the merchant a `errors.generic` banner with no indication
    // which field caused it. This mirrors createCategory/createBrand exactly.
    const clash = await tx.warehouse.findFirst({
      where: { companyId: ctx.companyId, code: input.code },
    });
    if (clash) throw new ServiceError("DUPLICATE_WAREHOUSE_CODE");

    // "The default warehouse" (singular) is assumed by prisma/seed.ts and by
    // Tasks 7-9 — without this, marking a new warehouse default would leave
    // the previous default also `isDefault: true`, and any `findFirstOrThrow
    // ({ isDefault: true })` caller would nondeterministically get whichever
    // row Prisma happens to return first. Unset inside the same transaction
    // so a crash between the two writes can never leave two defaults
    // committed. (Creating a warehouse can never drop the count to zero —
    // it only ever adds a row or swaps which existing one is default — so
    // that half of the invariant is `updateWarehouse`'s job below, guarding
    // the one place a company CAN be left with none: unchecking "default"
    // on the current default with nothing else to take its place.)
    if (input.isDefault) {
      await tx.warehouse.updateMany({
        where: { companyId: ctx.companyId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const warehouse = await tx.warehouse.create({
      data: {
        companyId: ctx.companyId,
        name: input.name,
        code: input.code,
        city: input.city ?? null,
        isDefault: input.isDefault ?? false,
      },
    });

    await writeAudit(tx, ctx, {
      action: "WAREHOUSE_CREATED",
      entityType: "Warehouse",
      entityId: warehouse.id,
      newValues: { name: warehouse.name, code: warehouse.code },
    });

    return warehouse;
  });
}

export async function updateWarehouse(
  ctx: ServiceContext,
  warehouseId: string,
  input: WarehouseWriteInput,
) {
  return prisma.$transaction(async (tx) => {
    // Tenant check on every write, never a bare update-by-id (same rule as
    // updateProduct in src/services/products.ts): a stale link or a
    // cross-company id must read as NOT_FOUND (mapped by action()'s P2025
    // branch), never silently mutate or miss another company's row.
    const existing = await tx.warehouse.findFirstOrThrow({
      where: { id: warehouseId, companyId: ctx.companyId },
    });

    if (input.code !== undefined && input.code !== existing.code) {
      const clash = await tx.warehouse.findFirst({
        where: { companyId: ctx.companyId, code: input.code, id: { not: warehouseId } },
      });
      if (clash) throw new ServiceError("DUPLICATE_WAREHOUSE_CODE");
    }

    // WarehouseForm's checkbox preprocesses to `isDefault: false` on every
    // unchecked submit, not just when the merchant meant to change it — so
    // an edit of the current default with the box left unchecked reaches
    // here as an explicit `false` every time. Unsetting it with no other
    // warehouse already holding `isDefault: true` would leave the company
    // with NONE, and prisma/seed.ts (plus any future Task 7-9 read) does
    // `findFirstOrThrow({ isDefault: true })` — a hard 500, not a graceful
    // miss. Block it here rather than silently keeping the old value or
    // auto-picking a replacement, so the merchant has to explicitly make
    // another warehouse the default first.
    if (input.isDefault === false && existing.isDefault) {
      const anotherDefault = await tx.warehouse.findFirst({
        where: { companyId: ctx.companyId, isDefault: true, id: { not: warehouseId } },
      });
      if (!anotherDefault) throw new ServiceError("LAST_DEFAULT_WAREHOUSE");
    }

    // Old/new value diff, audited only when something actually changed —
    // identical shape to updateProduct's diff loop in src/services/products.ts.
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const existingValue = (existing as Record<string, unknown>)[key];
      if (existingValue !== value) {
        oldValues[key] = existingValue;
        newValues[key] = value;
      }
      data[key] = value;
    }

    // Same "only one default" invariant as createWarehouse above — unset any
    // OTHER warehouse currently holding it, inside the same transaction as
    // this update, before this row is (re)marked default. Not gated on
    // `existing.isDefault` being false: this also self-heals any row a
    // pre-fix write left incorrectly marked default alongside this one.
    if (input.isDefault === true) {
      await tx.warehouse.updateMany({
        where: { companyId: ctx.companyId, isDefault: true, id: { not: warehouseId } },
        data: { isDefault: false },
      });
    }

    const warehouse = await tx.warehouse.update({ where: { id: warehouseId }, data });

    if (Object.keys(newValues).length > 0) {
      await writeAudit(tx, ctx, {
        action: "WAREHOUSE_UPDATED",
        entityType: "Warehouse",
        entityId: warehouse.id,
        oldValues,
        newValues,
      });
    }

    return warehouse;
  });
}

import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { writeAudit } from "@/services/audit";
import { ServiceError } from "@/services/errors";

export interface SupplierWriteInput {
  name?: string;
  companyName?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  country?: string | null;
  city?: string | null;
  address?: string | null;
  taxNumber?: string | null;
  paymentTermsDays?: number;
  notes?: string | null;
  status?: string;
}

function assertValid(input: SupplierWriteInput) {
  if (input.paymentTermsDays !== undefined && input.paymentTermsDays < 0) {
    throw new ServiceError("INVALID_PAYMENT_TERMS");
  }
}

/**
 * Permission enforcement (`suppliers.create`/`suppliers.edit`) lives in the
 * server action wrapper (`src/lib/action.ts`'s `action()`), not here — same
 * division of responsibility as `createProduct`/`createWarehouse`.
 */
export async function createSupplier(
  ctx: ServiceContext,
  input: SupplierWriteInput & { name: string },
) {
  if (input.name.trim() === "") throw new ServiceError("INVALID_NAME");
  assertValid(input);

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({
      data: {
        companyId: ctx.companyId,
        name: input.name,
        companyName: input.companyName ?? null,
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        country: input.country ?? null,
        city: input.city ?? null,
        address: input.address ?? null,
        taxNumber: input.taxNumber ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 0,
        notes: input.notes ?? null,
        status: input.status ?? "ACTIVE",
      },
    });

    await writeAudit(tx, ctx, {
      action: "SUPPLIER_CREATED",
      entityType: "Supplier",
      entityId: supplier.id,
      newValues: { name: supplier.name },
    });

    return supplier;
  });
}

export async function updateSupplier(
  ctx: ServiceContext,
  supplierId: string,
  input: SupplierWriteInput,
) {
  if (input.name !== undefined && input.name.trim() === "") {
    throw new ServiceError("INVALID_NAME");
  }
  assertValid(input);

  return prisma.$transaction(async (tx) => {
    // Tenant check on every write, never a bare update-by-id — same rule as
    // updateProduct/updateWarehouse: a stale link or a cross-company id must
    // read as NOT_FOUND (mapped by action()'s P2025 branch), not silently
    // mutate or miss another company's row.
    const existing = await tx.supplier.findFirstOrThrow({
      where: { id: supplierId, companyId: ctx.companyId },
    });

    // Explicit allowlist, not a generic Object.entries copy over `input` —
    // SupplierWriteInput crosses the action-layer schema boundary, and an
    // enumerable-key copy would forward any unexpected/future key straight
    // into Prisma's update payload with no chance to review it here.
    const UPDATABLE_FIELDS = [
      "name", "companyName", "contactPerson", "phone", "email", "country",
      "city", "address", "taxNumber", "paymentTermsDays", "notes", "status",
    ] as const;

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};
    for (const key of UPDATABLE_FIELDS) {
      const value = input[key];
      if (value === undefined) continue;
      const existingValue = (existing as Record<string, unknown>)[key];
      if (existingValue !== value) {
        oldValues[key] = existingValue;
        newValues[key] = value;
      }
      data[key] = value;
    }

    const supplier = await tx.supplier.update({ where: { id: supplierId }, data });

    if (Object.keys(newValues).length > 0) {
      await writeAudit(tx, ctx, {
        action: "SUPPLIER_UPDATED",
        entityType: "Supplier",
        entityId: supplier.id,
        oldValues,
        newValues,
      });
    }

    return supplier;
  });
}

import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { writeAudit } from "@/services/audit";
import { ServiceError } from "@/services/errors";
import { CUSTOMER_TYPES } from "@/lib/constants";

export interface CustomerWriteInput {
  customerType?: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  country?: string | null;
  city?: string | null;
  address?: string | null;
  taxNumber?: string | null;
  creditLimit?: number;
  paymentTermsDays?: number;
  notes?: string | null;
  status?: string;
}

function assertValid(input: CustomerWriteInput) {
  if (input.customerType !== undefined && !(CUSTOMER_TYPES as readonly string[]).includes(input.customerType)) {
    throw new ServiceError("INVALID_CUSTOMER_TYPE");
  }
  if (input.paymentTermsDays !== undefined && input.paymentTermsDays < 0) {
    throw new ServiceError("INVALID_PAYMENT_TERMS");
  }
  if (input.creditLimit !== undefined && input.creditLimit < 0) {
    throw new ServiceError("INVALID_CREDIT_LIMIT");
  }
}

/**
 * Permission enforcement (`customers.create`/`customers.edit`) lives in the
 * server action wrapper (`src/lib/action.ts`'s `action()`), not here — same
 * division of responsibility as `createSupplier`/`createProduct`.
 */
export async function createCustomer(
  ctx: ServiceContext,
  input: CustomerWriteInput & { name: string },
) {
  if (input.name.trim() === "") throw new ServiceError("INVALID_NAME");
  assertValid(input);

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        companyId: ctx.companyId,
        customerType: input.customerType ?? "RETAIL",
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        country: input.country ?? null,
        city: input.city ?? null,
        address: input.address ?? null,
        taxNumber: input.taxNumber ?? null,
        creditLimit: input.creditLimit ?? 0,
        paymentTermsDays: input.paymentTermsDays ?? 0,
        notes: input.notes ?? null,
        status: input.status ?? "ACTIVE",
      },
    });

    await writeAudit(tx, ctx, {
      action: "CUSTOMER_CREATED",
      entityType: "Customer",
      entityId: customer.id,
      newValues: { name: customer.name },
    });

    return customer;
  });
}

export async function updateCustomer(
  ctx: ServiceContext,
  customerId: string,
  input: CustomerWriteInput,
) {
  if (input.name !== undefined && input.name.trim() === "") {
    throw new ServiceError("INVALID_NAME");
  }
  assertValid(input);

  return prisma.$transaction(async (tx) => {
    // Tenant check on every write, never a bare update-by-id — same rule as
    // updateSupplier/updateProduct: a stale link or a cross-company id must
    // read as NOT_FOUND (mapped by action()'s P2025 branch), not silently
    // mutate or miss another company's row.
    const existing = await tx.customer.findFirstOrThrow({
      where: { id: customerId, companyId: ctx.companyId },
    });

    // Explicit allowlist, not a generic Object.entries copy over `input` —
    // same convention as updateSupplier's UPDATABLE_FIELDS.
    const UPDATABLE_FIELDS = [
      "customerType", "name", "phone", "email", "country", "city", "address",
      "taxNumber", "creditLimit", "paymentTermsDays", "notes", "status",
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

    const customer = await tx.customer.update({ where: { id: customerId }, data });

    if (Object.keys(newValues).length > 0) {
      await writeAudit(tx, ctx, {
        action: "CUSTOMER_UPDATED",
        entityType: "Customer",
        entityId: customer.id,
        oldValues,
        newValues,
      });
    }

    return customer;
  });
}

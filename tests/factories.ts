import { prisma } from "@/lib/db";
import { toMinor, toQty } from "@/lib/money";
import type { ServiceContext } from "@/services/context";

/**
 * Cached because this runs before every one of ~750 tests and the answer
 * cannot change within a run — the schema is provisioned before vitest starts.
 */
let tableNames: string[] | null = null;

/**
 * Clear DATA from every table, with foreign keys off for the duration.
 *
 * This used to be `company.deleteMany()` and lean on the Company cascade, which
 * made it hostage to the ORDER SQLite happens to process cascades in. This
 * schema is full of RESTRICT keys pointing at Product and Warehouse
 * (InventoryMovement.productId, StockClaim.productId, PurchaseOrder.warehouseId
 * and ~40 more), and if the cascade reaches Product before the rows referencing
 * it, RESTRICT fires and the whole delete is refused.
 *
 * `prisma db push` rebuilds a table to add a column, which reshuffles that
 * order. Adding one boolean to Product turned 406 tests red without a single
 * line of production code being at fault.
 *
 * tests/global-setup.ts already clears data exactly this way, and for the same
 * reason. The table list is derived from sqlite_master so it cannot drift as
 * models are added.
 */
export async function resetDb() {
  if (!tableNames) {
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name != '_prisma_migrations'`,
    );
    tableNames = rows.map((r) => r.name);
  }

  // The PRAGMA has to sit OUTSIDE the transaction: SQLite silently ignores
  // `PRAGMA foreign_keys` while one is open, so setting it inside would leave
  // the constraints on and reintroduce the ordering problem.
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  try {
    // One transaction rather than a statement each. Run separately, ~50 deletes
    // before every one of ~750 tests tripled the suite's wall clock.
    await prisma.$transaction(
      tableNames.map((name) => prisma.$executeRawUnsafe(`DELETE FROM "${name}"`)),
    );
  } finally {
    // Restored even if a delete throws: leaving foreign keys off would let a
    // later test write rows the schema forbids and pass on a lie.
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }
}

export async function makeCompany(name = "Test Co") {
  return prisma.company.create({ data: { name } });
}

export function makeCtx(companyId: string, userId: string | null = null): ServiceContext {
  return { companyId, userId };
}

export async function makeWarehouse(companyId: string, code = "MAIN") {
  return prisma.warehouse.create({
    data: { companyId, name: code, code, isDefault: code === "MAIN" },
  });
}

type ProductOverrides = Partial<{
  sku: string;
  sellingPrice: number;
  weightGrams: number;
  nameEn: string;
  categoryId: string;
}>;

export async function makeProduct(
  companyId: string,
  skuOrOverrides: string | ProductOverrides = "SKU-1",
  overrides: ProductOverrides = {},
) {
  // Accepts either the original (companyId, sku, overrides) call shape or
  // (companyId, overrides) with `sku` folded in — callers that only need to
  // vary the SKU (e.g. a second product in the same company) shouldn't have
  // to spell out every other field.
  const opts: ProductOverrides =
    typeof skuOrOverrides === "string" ? { sku: skuOrOverrides, ...overrides } : skuOrOverrides;
  const sku = opts.sku ?? "SKU-1";

  return prisma.product.create({
    data: {
      companyId,
      nameAr: opts.nameEn ?? sku,
      nameEn: opts.nameEn ?? sku,
      sku,
      sellingPrice: opts.sellingPrice ?? toMinor(100),
      weightGrams: opts.weightGrams ?? 1000,
      categoryId: opts.categoryId ?? null,
    },
  });
}

export async function makeCategory(
  companyId: string,
  nameEn = "Category A",
  parentId: string | null = null,
) {
  return prisma.productCategory.create({
    data: { companyId, nameAr: nameEn, nameEn, parentId },
  });
}

type ProductVariantOverrides = Partial<{ sku: string; name: string }>;

export async function makeProductVariant(
  companyId: string,
  productId: string,
  overrides: ProductVariantOverrides = {},
) {
  return prisma.productVariant.create({
    data: {
      companyId,
      productId,
      name: overrides.name ?? "Variant A",
      sku: overrides.sku ?? "SKU-1-VAR",
    },
  });
}

export async function makeSupplier(companyId: string, name = "Supplier A") {
  return prisma.supplier.create({ data: { companyId, name } });
}

export async function makeCustomer(companyId: string, name = "Customer A") {
  return prisma.customer.create({ data: { companyId, name } });
}

export async function makeAccount(companyId: string, name = "Cash", opening = 0) {
  return prisma.financialAccount.create({
    data: {
      companyId, name, accountType: "CASH",
      openingBalance: opening, currentBalance: opening, isDefault: true,
    },
  });
}

export async function makeExpenseCategory(companyId: string, nameEn = "Rent") {
  return prisma.expenseCategory.create({
    data: { companyId, nameAr: nameEn, nameEn },
  });
}

export async function makeClaim(
  companyId: string,
  productId: string,
  kind = "RETURN",
  quantity = toQty(5),
  assertedBy = "SALLA",
  sourceKey = "",
) {
  return prisma.stockClaim.create({
    data: { companyId, productId, kind, quantity, assertedBy, sourceKey },
  });
}

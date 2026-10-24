import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { writeAudit } from "@/services/audit";
import { ServiceError } from "@/services/errors";

/**
 * `registerCompany` seeds zero categories and zero brands for a new company
 * (see prisma/seed.ts, which creates a demo category/brand by hand). Without
 * these two functions the products list's category/brand filters — and the
 * add/edit product form's pickers — would be permanently empty selects,
 * which violates the "no placeholder UI" rule. Both follow the Stage 1A
 * service pattern: single transaction, tenant-scoped duplicate check,
 * ServiceError on conflict, audit row.
 */
export async function createCategory(
  ctx: ServiceContext,
  input: { nameAr: string; nameEn: string; parentId?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    if (input.parentId) {
      // Tenant-scoped lookup: a P2025 miss here (e.g. a parent from another
      // company, or a stale id) is mapped to NOT_FOUND by the `action()`
      // helper, not a raw 500.
      await tx.productCategory.findFirstOrThrow({
        where: { id: input.parentId, companyId: ctx.companyId },
      });
    }

    const clash = await tx.productCategory.findFirst({
      where: {
        companyId: ctx.companyId,
        OR: [{ nameAr: input.nameAr }, { nameEn: input.nameEn }],
      },
    });
    if (clash) throw new ServiceError("DUPLICATE_CATEGORY");

    const category = await tx.productCategory.create({
      data: {
        companyId: ctx.companyId,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        parentId: input.parentId ?? null,
      },
    });

    await writeAudit(tx, ctx, {
      action: "CATEGORY_CREATED",
      entityType: "ProductCategory",
      entityId: category.id,
      newValues: { nameAr: input.nameAr, nameEn: input.nameEn },
    });

    return category;
  });
}

/**
 * `Brand` (unlike `ProductCategory`) has a single `name` column, not
 * `nameAr`/`nameEn` — the schema has no localized brand name. Matches the
 * actual Prisma model, not a bilingual signature.
 */
export async function createBrand(ctx: ServiceContext, input: { name: string }) {
  return prisma.$transaction(async (tx) => {
    const clash = await tx.brand.findFirst({
      where: { companyId: ctx.companyId, name: input.name },
    });
    if (clash) throw new ServiceError("DUPLICATE_BRAND");

    const brand = await tx.brand.create({
      data: { companyId: ctx.companyId, name: input.name },
    });

    await writeAudit(tx, ctx, {
      action: "BRAND_CREATED",
      entityType: "Brand",
      entityId: brand.id,
      newValues: { name: input.name },
    });

    return brand;
  });
}

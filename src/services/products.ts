import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { ProductType } from "@/lib/constants";
import { writeAudit } from "@/services/audit";
import { ServiceError, invalidState } from "@/services/errors";

export interface ProductWriteInput {
  nameAr?: string;
  nameEn?: string;
  sku?: string;
  barcode?: string | null;
  categoryId?: string | null;
  brandId?: string | null;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  purchasePrice?: number;
  sellingPrice?: number;
  wholesalePrice?: number;
  minSellingPrice?: number;
  taxRatePct?: number;
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  reorderLevel?: number;
  reorderQty?: number;
  trackInventory?: boolean;
  allowBackorder?: boolean;
}

function assertNonNegativeAmounts(input: ProductWriteInput) {
  for (const field of [
    "purchasePrice", "sellingPrice", "wholesalePrice", "minSellingPrice",
  ] as const) {
    const value = input[field];
    if (value !== undefined && value < 0) throw new ServiceError("INVALID_PRICE", { field });
  }
  if (input.taxRatePct !== undefined && (input.taxRatePct < 0 || input.taxRatePct > 10_000)) {
    throw new ServiceError("INVALID_TAX_RATE");
  }
  for (const field of ["reorderLevel", "reorderQty"] as const) {
    const value = input[field];
    if (value !== undefined && value < 0) {
      throw invalidState("QUANTITY_MUST_BE_NON_NEGATIVE", { field });
    }
  }
  for (const field of ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const) {
    const value = input[field];
    if (value !== undefined && value < 0) {
      throw invalidState("QUANTITY_MUST_BE_NON_NEGATIVE", { field });
    }
  }
}

export async function createProduct(
  ctx: ServiceContext,
  input: ProductWriteInput & { nameAr: string; nameEn: string; sku: string },
) {
  if (input.sku.trim() === "") throw new ServiceError("INVALID_SKU");
  assertNonNegativeAmounts(input);

  return prisma.$transaction(async (tx) => {
    if (input.categoryId) {
      await tx.productCategory.findFirstOrThrow({
        where: { id: input.categoryId, companyId: ctx.companyId },
      });
    }
    if (input.brandId) {
      await tx.brand.findFirstOrThrow({ where: { id: input.brandId, companyId: ctx.companyId } });
    }

    const clash = await tx.product.findFirst({
      where: { companyId: ctx.companyId, sku: input.sku },
    });
    if (clash) throw new ServiceError("DUPLICATE_SKU");

    const product = await tx.product.create({
      data: {
        companyId: ctx.companyId,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        sku: input.sku,
        barcode: input.barcode ?? null,
        categoryId: input.categoryId ?? null,
        brandId: input.brandId ?? null,
        descriptionAr: input.descriptionAr ?? null,
        descriptionEn: input.descriptionEn ?? null,
        purchasePrice: input.purchasePrice ?? 0,
        sellingPrice: input.sellingPrice ?? 0,
        wholesalePrice: input.wholesalePrice ?? 0,
        minSellingPrice: input.minSellingPrice ?? 0,
        taxRatePct: input.taxRatePct ?? 1500,
        weightGrams: input.weightGrams ?? 0,
        lengthMm: input.lengthMm ?? 0,
        widthMm: input.widthMm ?? 0,
        heightMm: input.heightMm ?? 0,
        reorderLevel: input.reorderLevel ?? 0,
        reorderQty: input.reorderQty ?? 0,
        trackInventory: input.trackInventory ?? true,
        allowBackorder: input.allowBackorder ?? false,
      },
    });

    await writeAudit(tx, ctx, {
      action: "PRODUCT_CREATED",
      entityType: "Product",
      entityId: product.id,
      newValues: { sku: product.sku, nameEn: product.nameEn },
    });

    return product;
  });
}

export async function updateProduct(
  ctx: ServiceContext,
  productId: string,
  input: ProductWriteInput,
) {
  assertNonNegativeAmounts(input);

  return prisma.$transaction(async (tx) => {
    // Tenant check on every write, never a bare update-by-id: a stale link
    // or a cross-company id must read as NOT_FOUND (mapped by the action()
    // helper's P2025 branch), not silently mutate/miss another company's row.
    const existing = await tx.product.findFirstOrThrow({
      where: { id: productId, companyId: ctx.companyId },
    });

    if (input.categoryId) {
      await tx.productCategory.findFirstOrThrow({
        where: { id: input.categoryId, companyId: ctx.companyId },
      });
    }
    if (input.brandId) {
      await tx.brand.findFirstOrThrow({ where: { id: input.brandId, companyId: ctx.companyId } });
    }

    if (input.sku !== undefined && input.sku !== existing.sku) {
      if (input.sku.trim() === "") throw new ServiceError("INVALID_SKU");
      const clash = await tx.product.findFirst({
        where: { companyId: ctx.companyId, sku: input.sku, id: { not: productId } },
      });
      if (clash) throw new ServiceError("DUPLICATE_SKU");
    }

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

    const product = await tx.product.update({ where: { id: productId }, data });

    if (Object.keys(newValues).length > 0) {
      await writeAudit(tx, ctx, {
        action: "PRODUCT_UPDATED",
        entityType: "Product",
        entityId: product.id,
        oldValues,
        newValues,
      });
    }

    return product;
  });
}

export async function archiveProduct(ctx: ServiceContext, productId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.product.findFirstOrThrow({
      where: { id: productId, companyId: ctx.companyId },
    });
    if (existing.status === "ARCHIVED") throw new ServiceError("ALREADY_ARCHIVED");

    // A status flip, never a delete — every reference this product has
    // (movements, order lines, balances) must keep resolving.
    const product = await tx.product.update({
      where: { id: productId },
      data: { status: "ARCHIVED" },
    });

    await writeAudit(tx, ctx, {
      action: "PRODUCT_ARCHIVED",
      entityType: "Product",
      entityId: product.id,
      oldValues: { status: existing.status },
      newValues: { status: "ARCHIVED" },
    });

    return product;
  });
}

export interface VariantWriteInput {
  name?: string;
  sku?: string;
  barcode?: string | null;
  attributes?: Record<string, string>;
  purchasePrice?: number;
  sellingPrice?: number;
  wholesalePrice?: number;
  minSellingPrice?: number;
  weightGrams?: number;
}

export async function createVariant(
  ctx: ServiceContext,
  productId: string,
  input: VariantWriteInput & { name: string; sku: string },
) {
  if (input.sku.trim() === "") throw new ServiceError("INVALID_SKU");

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirstOrThrow({
      where: { id: productId, companyId: ctx.companyId },
    });

    const clash = await tx.productVariant.findFirst({
      where: { companyId: ctx.companyId, sku: input.sku },
    });
    if (clash) throw new ServiceError("DUPLICATE_SKU");

    // A variant with no price of its own inherits the parent's price at
    // creation time (a snapshot, not a live link — editing the parent's
    // price later does not retroactively change existing variants).
    //
    // The four price fields deliberately use `||`, not `??`: a variant
    // explicitly priced at 0 still inherits the parent's price, because 0 is
    // never a meaningful price for a sellable line (a $0 variant would sell
    // for nothing) — `??` would let an explicit 0 stick and silently zero the
    // variant's price. `weightGrams` uses `??` instead, on purpose: 0g is a
    // legitimate explicit weight (e.g. a digital or weightless variant), so
    // it must NOT fall back to the parent's weight the way `||` would treat
    // it as unset.
    const variant = await tx.productVariant.create({
      data: {
        companyId: ctx.companyId,
        productId,
        name: input.name,
        sku: input.sku,
        barcode: input.barcode ?? null,
        attributes: JSON.stringify(input.attributes ?? {}),
        purchasePrice: input.purchasePrice || product.purchasePrice,
        sellingPrice: input.sellingPrice || product.sellingPrice,
        wholesalePrice: input.wholesalePrice || product.wholesalePrice,
        minSellingPrice: input.minSellingPrice || product.minSellingPrice,
        weightGrams: input.weightGrams ?? product.weightGrams,
      },
    });

    // Adding the first variant flips the parent from SIMPLE to VARIANT so
    // the detail page starts rendering the variants table.
    const productType: ProductType = "VARIANT";
    if (product.productType !== productType) {
      await tx.product.update({ where: { id: productId }, data: { productType } });
    }

    await writeAudit(tx, ctx, {
      action: "VARIANT_CREATED",
      entityType: "ProductVariant",
      entityId: variant.id,
      newValues: { sku: variant.sku, name: variant.name, productId },
    });

    return variant;
  });
}

export async function updateVariant(
  ctx: ServiceContext,
  variantId: string,
  input: VariantWriteInput,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.productVariant.findFirstOrThrow({
      where: { id: variantId, companyId: ctx.companyId },
    });

    if (input.sku !== undefined && input.sku !== existing.sku) {
      if (input.sku.trim() === "") throw new ServiceError("INVALID_SKU");
      const clash = await tx.productVariant.findFirst({
        where: { companyId: ctx.companyId, sku: input.sku, id: { not: variantId } },
      });
      if (clash) throw new ServiceError("DUPLICATE_SKU");
    }

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const stored = key === "attributes" ? JSON.stringify(value) : value;
      const existingValue = (existing as Record<string, unknown>)[key];
      if (existingValue !== stored) {
        oldValues[key] = existingValue;
        newValues[key] = stored;
      }
      data[key] = stored;
    }

    const variant = await tx.productVariant.update({ where: { id: variantId }, data });

    if (Object.keys(newValues).length > 0) {
      await writeAudit(tx, ctx, {
        action: "VARIANT_UPDATED",
        entityType: "ProductVariant",
        entityId: variant.id,
        oldValues,
        newValues,
      });
    }

    return variant;
  });
}

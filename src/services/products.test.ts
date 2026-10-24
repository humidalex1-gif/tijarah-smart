import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toMinor, toQty } from "@/lib/money";
import {
  createProduct, updateProduct, archiveProduct, createVariant, updateVariant,
} from "@/services/products";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

describe("createProduct", () => {
  beforeEach(resetDb);

  it("assigns the caller's company and audits the creation", async () => {
    const company = await makeCompany();
    const product = await createProduct(makeCtx(company.id), {
      nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT-1",
      sellingPrice: toMinor(100),
    });

    expect(product.companyId).toBe(company.id);
    expect(product.status).toBe("ACTIVE");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_CREATED" } });
    expect(log.entityType).toBe("Product");
    expect(log.entityId).toBe(product.id);
  });

  it("rejects a duplicate SKU within the same company", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "DUP-1" });

    await expect(
      createProduct(ctx, { nameAr: "ب", nameEn: "B", sku: "DUP-1" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SKU" });
  });

  it("allows the same SKU in a different company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    await createProduct(makeCtx(companyA.id), { nameAr: "أ", nameEn: "A", sku: "SHARED" });

    await expect(
      createProduct(makeCtx(companyB.id), { nameAr: "ب", nameEn: "B", sku: "SHARED" }),
    ).resolves.toBeDefined();
  });

  it("rejects a negative selling price", async () => {
    const company = await makeCompany();
    await expect(
      createProduct(makeCtx(company.id), {
        nameAr: "أ", nameEn: "A", sku: "NEG-1", sellingPrice: -toMinor(10),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PRICE" });
  });
});

describe("updateProduct", () => {
  beforeEach(resetDb);

  it("records old and new values in the audit log", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, {
      nameAr: "أ", nameEn: "Old Name", sku: "UPD-1", sellingPrice: toMinor(100),
    });

    await updateProduct(ctx, product.id, { nameEn: "New Name", sellingPrice: toMinor(150) });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_UPDATED" } });
    const oldValues = JSON.parse(log.oldValues!);
    const newValues = JSON.parse(log.newValues!);
    expect(oldValues.nameEn).toBe("Old Name");
    expect(newValues.nameEn).toBe("New Name");
    expect(oldValues.sellingPrice).toBe(toMinor(100));
    expect(newValues.sellingPrice).toBe(toMinor(150));

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.nameEn).toBe("New Name");
    expect(updated.sellingPrice).toBe(toMinor(150));
  });

  it("rejects renaming the SKU to one already used by another product", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "TAKEN" });
    const productB = await createProduct(ctx, { nameAr: "ب", nameEn: "B", sku: "FREE" });

    await expect(
      updateProduct(ctx, productB.id, { sku: "TAKEN" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SKU" });
  });

  it("allows keeping the product's own SKU unchanged", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "SAME" });

    await expect(
      updateProduct(ctx, product.id, { sku: "SAME", nameEn: "A2" }),
    ).resolves.toBeDefined();
  });

  it("cannot update a product belonging to another company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const product = await createProduct(makeCtx(companyA.id), {
      nameAr: "أ", nameEn: "A", sku: "X",
    });

    await expect(
      updateProduct(makeCtx(companyB.id), product.id, { nameEn: "Hijacked" }),
    ).rejects.toThrow();
  });
});

describe("archiveProduct", () => {
  beforeEach(resetDb);

  it("sets status ARCHIVED without deleting the row", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "ARC-1" });

    await archiveProduct(ctx, product.id);

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stored.status).toBe("ARCHIVED");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_ARCHIVED" } });
    expect(log.entityId).toBe(product.id);
  });

  it("refuses to archive twice", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "ARC-2" });
    await archiveProduct(ctx, product.id);

    await expect(archiveProduct(ctx, product.id)).rejects.toMatchObject({
      code: "ALREADY_ARCHIVED",
    });
  });
});

describe("createVariant", () => {
  beforeEach(resetDb);

  it("inherits the parent's prices when its own are zero", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, {
      nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT-1",
      purchasePrice: toMinor(40), sellingPrice: toMinor(100),
    });

    const variant = await createVariant(ctx, product.id, {
      name: "Red / Large", sku: "SHIRT-1-RED-L",
    });

    expect(variant.purchasePrice).toBe(toMinor(40));
    expect(variant.sellingPrice).toBe(toMinor(100));
  });

  it("keeps its own price when one is given", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, {
      nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT-2", sellingPrice: toMinor(100),
    });

    const variant = await createVariant(ctx, product.id, {
      name: "Blue / Small", sku: "SHIRT-2-BLUE-S", sellingPrice: toMinor(120),
    });

    expect(variant.sellingPrice).toBe(toMinor(120));
  });

  it("rejects a variant SKU already used by another variant in the company", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const productA = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "PA" });
    const productB = await createProduct(ctx, { nameAr: "ب", nameEn: "B", sku: "PB" });
    await createVariant(ctx, productA.id, { name: "V1", sku: "VARIANT-DUP" });

    await expect(
      createVariant(ctx, productB.id, { name: "V2", sku: "VARIANT-DUP" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SKU" });
  });

  it("flips the parent's productType to VARIANT", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "FLIP-1" });
    expect(product.productType).toBe("SIMPLE");

    await createVariant(ctx, product.id, { name: "V1", sku: "FLIP-1-A" });

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.productType).toBe("VARIANT");
  });
});

describe("updateVariant", () => {
  beforeEach(resetDb);

  it("records the change in the audit log", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "UV-1" });
    const variant = await createVariant(ctx, product.id, {
      name: "V1", sku: "UV-1-A", sellingPrice: toMinor(50),
    });

    await updateVariant(ctx, variant.id, { sellingPrice: toMinor(75) });

    const stored = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(stored.sellingPrice).toBe(toMinor(75));

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "VARIANT_UPDATED" } });
    expect(log.entityId).toBe(variant.id);
  });

  it("rejects renaming to a SKU already used by another variant", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const product = await createProduct(ctx, { nameAr: "أ", nameEn: "A", sku: "UV-2" });
    await createVariant(ctx, product.id, { name: "V1", sku: "UV-2-A" });
    const variantB = await createVariant(ctx, product.id, { name: "V2", sku: "UV-2-B" });

    await expect(
      updateVariant(ctx, variantB.id, { sku: "UV-2-A" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SKU" });
  });
});

// Sanity check that toQty is the right scale for reorder levels stored on
// Product, matching the brief's "reorder level with toQty" note.
describe("createProduct reorder level scaling", () => {
  beforeEach(resetDb);

  it("stores the reorder level at QTY_SCALE", async () => {
    const company = await makeCompany();
    const product = await createProduct(makeCtx(company.id), {
      nameAr: "أ", nameEn: "A", sku: "QTY-1", reorderLevel: toQty(20),
    });
    expect(product.reorderLevel).toBe(toQty(20));
  });
});

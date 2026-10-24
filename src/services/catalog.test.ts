import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { createCategory, createBrand } from "@/services/catalog";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

describe("createCategory", () => {
  beforeEach(resetDb);

  it("creates a category under the caller's company and audits it", async () => {
    const company = await makeCompany();
    const category = await createCategory(makeCtx(company.id), {
      nameAr: "إلكترونيات", nameEn: "Electronics",
    });

    expect(category.companyId).toBe(company.id);
    const stored = await prisma.productCategory.findUniqueOrThrow({ where: { id: category.id } });
    expect(stored.nameEn).toBe("Electronics");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "CATEGORY_CREATED" } });
    expect(log.entityType).toBe("ProductCategory");
    expect(log.entityId).toBe(category.id);
  });

  it("rejects a same-company name clash", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createCategory(ctx, { nameAr: "إلكترونيات", nameEn: "Electronics" });

    await expect(
      createCategory(ctx, { nameAr: "إلكترونيات", nameEn: "Electronics" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_CATEGORY" });
  });

  it("allows the same name in a different company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    await createCategory(makeCtx(companyA.id), { nameAr: "إلكترونيات", nameEn: "Electronics" });

    await expect(
      createCategory(makeCtx(companyB.id), { nameAr: "إلكترونيات", nameEn: "Electronics" }),
    ).resolves.toBeDefined();
  });
});

describe("createBrand", () => {
  beforeEach(resetDb);

  it("creates a brand under the caller's company and audits it", async () => {
    const company = await makeCompany();
    const brand = await createBrand(makeCtx(company.id), { name: "TechLine" });

    expect(brand.companyId).toBe(company.id);
    const stored = await prisma.brand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(stored.name).toBe("TechLine");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "BRAND_CREATED" } });
    expect(log.entityType).toBe("Brand");
    expect(log.entityId).toBe(brand.id);
  });

  it("rejects a same-company name clash", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createBrand(ctx, { name: "TechLine" });

    await expect(createBrand(ctx, { name: "TechLine" })).rejects.toMatchObject({
      code: "DUPLICATE_BRAND",
    });
  });

  it("allows the same name in a different company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    await createBrand(makeCtx(companyA.id), { name: "TechLine" });

    await expect(
      createBrand(makeCtx(companyB.id), { name: "TechLine" }),
    ).resolves.toBeDefined();
  });
});

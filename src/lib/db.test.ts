import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb } from "../../tests/factories";

/**
 * Uses the shared `resetDb`, not a local `company.deleteMany()`.
 *
 * That naive form trips a foreign-key violation whenever any earlier test
 * file leaves child-to-child rows behind — order items point at products, and
 * that relation has no cascade, so deleting companies cannot unwind it. The
 * suite only stayed green while nothing before this file happened to leave a
 * sales order in place. `prisma/seed.ts` documents the same trap and solves it
 * the same way: wipe every table with foreign keys off.
 */

describe("schema", () => {
  beforeEach(resetDb);

  it("creates a company with a warehouse and a product", async () => {
    const company = await prisma.company.create({ data: { name: "Test Co" } });
    const warehouse = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN", isDefault: true },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, nameAr: "منتج", nameEn: "Product", sku: "SKU-1" },
    });

    expect(company.currencyCode).toBe("SAR");
    expect(company.allowNegativeInventory).toBe(false);
    expect(warehouse.status).toBe("ACTIVE");
    expect(product.productType).toBe("SIMPLE");
    expect(product.trackInventory).toBe(true);
  });

  it("enforces one SKU per company", async () => {
    const company = await prisma.company.create({ data: { name: "Test Co" } });
    await prisma.product.create({
      data: { companyId: company.id, nameAr: "أ", nameEn: "A", sku: "DUP" },
    });
    await expect(
      prisma.product.create({
        data: { companyId: company.id, nameAr: "ب", nameEn: "B", sku: "DUP" },
      }),
    ).rejects.toThrow();
  });

  it("enforces one balance row per warehouse/product/variant", async () => {
    const company = await prisma.company.create({ data: { name: "Test Co" } });
    const wh = await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    const p = await prisma.product.create({
      data: { companyId: company.id, nameAr: "أ", nameEn: "A", sku: "S1" },
    });
    await prisma.inventoryBalance.create({
      data: { companyId: company.id, warehouseId: wh.id, productId: p.id },
    });
    await expect(
      prisma.inventoryBalance.create({
        data: { companyId: company.id, warehouseId: wh.id, productId: p.id },
      }),
    ).rejects.toThrow();
  });

  it("cascades company deletion to its records", async () => {
    const company = await prisma.company.create({ data: { name: "Test Co" } });
    await prisma.warehouse.create({
      data: { companyId: company.id, name: "Main", code: "MAIN" },
    });
    await prisma.company.delete({ where: { id: company.id } });
    expect(await prisma.warehouse.count()).toBe(0);
  });
});

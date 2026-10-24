import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toMinor, toCost } from "@/lib/money";
import { importFastHubOpeningStock } from "@/services/fasthub/inventory";
import { receiveStockManual } from "@/services/stock";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The one-time opening import: Fast Hub's counts become the books' starting
 * balances. Ongoing syncs feed reconciliation instead — mirroring the
 * warehouse's numbers forever would erase the very discrepancy this project
 * exists to expose.
 */
describe("importFastHubOpeningStock", () => {
  beforeEach(resetDb);

  async function setup() {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    return { company, warehouse, ctx };
  }

  it("imports available into AVAILABLE and damaged into DAMAGED, both at zero cost", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "caddy-long-012");

    const report = await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "caddy-long-012", available: toQty(2), damaged: toQty(1) }],
    });

    expect(report.imported).toBe(1);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(balance.availableQty).toBe(toQty(2));
    expect(balance.damagedQty).toBe(toQty(1));
    // No invented costs: the value of this stock is unknown until the owner
    // supplies purchase prices, so it must enter the books at zero.
    expect(balance.avgCost).toBe(0);
  });

  it("carries a supplied unit cost into avgCost so inventory value is real", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "waves-light-004");
    const landed = toCost(toMinor(95.98));

    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "waves-light-004", available: toQty(30), damaged: 0, unitCost: landed }],
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(balance.avgCost).toBe(landed);
    expect(balance.availableQty).toBe(toQty(30));
  });

  it("skips a product that already has any balance, so a re-run cannot double stock", async () => {
    const { company, warehouse, ctx } = await setup();
    await makeProduct(company.id, "bowl-large-016");
    const counts = [{ sku: "bowl-large-016", available: toQty(174), damaged: 0 }];

    const first = await importFastHubOpeningStock(ctx, { warehouseId: warehouse.id, counts });
    const second = await importFastHubOpeningStock(ctx, { warehouseId: warehouse.id, counts });

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skippedExisting).toEqual(["bowl-large-016"]);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(174));
  });

  it("refuses to overwrite stock that arrived some other way", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "very-large");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(5), unitCost: 0,
    });

    const report = await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "very-large", available: toQty(14), damaged: 0 }],
    });

    expect(report.imported).toBe(0);
    expect(report.skippedExisting).toEqual(["very-large"]);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(5));
  });

  it("reports unknown skus and keeps importing the rest", async () => {
    const { company, warehouse, ctx } = await setup();
    await makeProduct(company.id, "caddy-oval-014");

    const report = await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [
        { sku: "no-such-sku", available: toQty(9), damaged: 0 },
        { sku: "caddy-oval-014", available: toQty(53), damaged: 0 },
      ],
    });

    expect(report.imported).toBe(1);
    expect(report.unknown).toEqual(["no-such-sku"]);
  });

  it("never gives a bundle stock of its own", async () => {
    const { company, warehouse, ctx } = await setup();
    await prisma.product.create({
      data: {
        companyId: company.id, nameAr: "باقة", nameEn: "Kit",
        sku: "kitchen-kit-111", isBundle: true, trackInventory: false,
      },
    });

    const report = await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "kitchen-kit-111", available: toQty(3), damaged: 0 }],
    });

    expect(report.imported).toBe(0);
    expect(report.skippedBundles).toEqual(["kitchen-kit-111"]);
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("skips zero-count rows instead of writing empty movements", async () => {
    const { company, warehouse, ctx } = await setup();
    await makeProduct(company.id, "marble-white-007");

    const report = await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "marble-white-007", available: 0, damaged: 0 }],
    });

    expect(report.imported).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("rejects a foreign warehouse", async () => {
    const { ctx } = await setup();
    const other = await makeCompany("Other Co");
    const foreignWarehouse = await makeWarehouse(other.id);
    await expect(importFastHubOpeningStock(ctx, {
      warehouseId: foreignWarehouse.id,
      counts: [],
    })).rejects.toThrow();
  });
});

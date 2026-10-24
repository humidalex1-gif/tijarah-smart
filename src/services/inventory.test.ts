import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { applyMovement, getBalance } from "@/services/inventory";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../tests/factories";

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const product = await makeProduct(company.id);
  return { company, warehouse, product, ctx: makeCtx(company.id) };
}

const baseRef = {
  referenceType: "MANUAL",
  referenceId: "ref-1",
  referenceNumber: "ADJ-0001",
};

describe("applyMovement IN", () => {
  beforeEach(resetDb);

  it("creates the balance row and sets the average cost on first receipt", async () => {
    const { warehouse, product, ctx } = await setup();

    const result = await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id,
      productId: product.id,
      movementType: "PURCHASE_RECEIPT",
      direction: "IN",
      quantity: toQty(10),
      unitCost: toCost(toMinor(50)),
      ...baseRef,
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(10));
    expect(balance.avgCost).toBe(toCost(toMinor(50)));
    expect(result.totalCost).toBe(toMinor(500));
    expect(result.balanceAfter).toBe(toQty(10));
  });

  it("recalculates the weighted average on a second receipt", async () => {
    const { warehouse, product, ctx } = await setup();
    const common = {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "PURCHASE_RECEIPT" as const, direction: "IN" as const, ...baseRef,
    };

    await applyMovement(prisma, ctx, { ...common, quantity: toQty(10), unitCost: toCost(toMinor(10)) });
    await applyMovement(prisma, ctx, { ...common, quantity: toQty(10), unitCost: toCost(toMinor(20)) });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(20));
    expect(balance.avgCost).toBe(toCost(toMinor(15)));
  });

  it("writes a movement row carrying the cost and resulting balance", async () => {
    const { warehouse, product, ctx } = await setup();
    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "PURCHASE_RECEIPT", direction: "IN",
      quantity: toQty(4), unitCost: toCost(toMinor(25)),
      reason: "Initial stock", ...baseRef,
    });

    const movement = await prisma.inventoryMovement.findFirstOrThrow();
    expect(movement.direction).toBe("IN");
    expect(movement.quantity).toBe(toQty(4));
    expect(movement.totalCost).toBe(toMinor(100));
    expect(movement.balanceAfter).toBe(toQty(4));
    expect(movement.reason).toBe("Initial stock");
    expect(movement.referenceNumber).toBe("ADJ-0001");
  });

  it("routes damaged receipts to the damaged bucket without touching available stock", async () => {
    const { warehouse, product, ctx } = await setup();
    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "DAMAGED", direction: "IN", bucket: "DAMAGED",
      quantity: toQty(3), unitCost: toCost(toMinor(10)), ...baseRef,
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.damagedQty).toBe(toQty(3));
    expect(balance.availableQty).toBe(0);
    expect(balance.avgCost).toBe(0);
  });

  it("refuses to touch another company's warehouse", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      applyMovement(prisma, a.ctx, {
        warehouseId: b.warehouse.id, productId: a.product.id,
        movementType: "PURCHASE_RECEIPT", direction: "IN",
        quantity: toQty(1), unitCost: toCost(toMinor(1)),
        referenceType: "MANUAL", referenceId: "x", referenceNumber: "X-1",
      }),
    ).rejects.toThrow();
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("refuses a product that belongs to another company", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      applyMovement(prisma, a.ctx, {
        warehouseId: a.warehouse.id, productId: b.product.id,
        movementType: "PURCHASE_RECEIPT", direction: "IN",
        quantity: toQty(1), unitCost: toCost(toMinor(1)),
        referenceType: "MANUAL", referenceId: "x", referenceNumber: "X-1",
      }),
    ).rejects.toThrow();
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("refuses a destination warehouse that belongs to another company", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      applyMovement(prisma, a.ctx, {
        warehouseId: a.warehouse.id, productId: a.product.id,
        destinationWarehouseId: b.warehouse.id,
        movementType: "TRANSFER_IN", direction: "IN",
        quantity: toQty(1), unitCost: toCost(toMinor(1)),
        referenceType: "MANUAL", referenceId: "x", referenceNumber: "X-1",
      }),
    ).rejects.toThrow();
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("keys the balance row by variant and reuses it across receipts of the same variant", async () => {
    const { warehouse, product, ctx } = await setup();
    const variant = await prisma.productVariant.create({
      data: { companyId: ctx.companyId, productId: product.id, name: "Red / M", sku: "SKU-1-RED-M" },
    });

    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id, variantId: variant.id,
      movementType: "PURCHASE_RECEIPT", direction: "IN",
      quantity: toQty(2), unitCost: toCost(toMinor(10)), ...baseRef,
    });
    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id, variantId: variant.id,
      movementType: "PURCHASE_RECEIPT", direction: "IN",
      quantity: toQty(3), unitCost: toCost(toMinor(10)), ...baseRef,
    });
    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "PURCHASE_RECEIPT", direction: "IN",
      quantity: toQty(1), unitCost: toCost(toMinor(10)), ...baseRef,
    });

    expect(await prisma.inventoryBalance.count()).toBe(2);
    const variantBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { variantId: variant.id },
    });
    expect(variantBalance.variantKey).toBe(variant.id);
    expect(variantBalance.availableQty).toBe(toQty(5));

    const plainBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { variantId: null },
    });
    expect(plainBalance.variantKey).toBe("");
    expect(plainBalance.availableQty).toBe(toQty(1));
  });

  it("rounds the weighted average per COST_SCALE on receipts with a fractional average", async () => {
    const { warehouse, product, ctx } = await setup();
    const common = {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "PURCHASE_RECEIPT" as const, direction: "IN" as const, ...baseRef,
    };

    await applyMovement(prisma, ctx, { ...common, quantity: toQty(1), unitCost: toCost(toMinor(10)) });
    await applyMovement(prisma, ctx, { ...common, quantity: toQty(2), unitCost: toCost(toMinor(11)) });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.avgCost).toBe(10_666_667);

    const result = await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "SALE", direction: "OUT",
      quantity: toQty(1), ...baseRef,
    });
    expect(result.totalCost).toBe(1067);
  });
});

describe("applyMovement OUT", () => {
  beforeEach(resetDb);

  async function stocked(qty = 10, unitMinor = 50) {
    const s = await setup();
    await applyMovement(prisma, s.ctx, {
      warehouseId: s.warehouse.id, productId: s.product.id,
      movementType: "PURCHASE_RECEIPT", direction: "IN",
      quantity: toQty(qty), unitCost: toCost(toMinor(unitMinor)), ...baseRef,
    });
    return s;
  }

  it("deducts stock and reports the average cost as the snapshot", async () => {
    const { warehouse, product, ctx } = await stocked();

    const result = await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "SALE", direction: "OUT",
      quantity: toQty(3), ...baseRef,
    });

    expect(result.unitCost).toBe(toCost(toMinor(50)));
    expect(result.totalCost).toBe(toMinor(150));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(7));
    expect(balance.avgCost).toBe(toCost(toMinor(50)));
  });

  it("refuses to go negative by default", async () => {
    const { warehouse, product, ctx } = await stocked(2);

    await expect(
      applyMovement(prisma, ctx, {
        warehouseId: warehouse.id, productId: product.id,
        movementType: "SALE", direction: "OUT",
        quantity: toQty(5), ...baseRef,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(2));
  });

  it("allows going negative when the company permits it", async () => {
    const { company, warehouse, product, ctx } = await stocked(2);
    await prisma.company.update({
      where: { id: company.id },
      data: { allowNegativeInventory: true },
    });

    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "SALE", direction: "OUT",
      quantity: toQty(5), ...baseRef,
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(-3));
  });

  it("uses an explicit unit cost when one is supplied (return at snapshot cost)", async () => {
    const { warehouse, product, ctx } = await stocked();

    const result = await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "ADJUSTMENT_OUT", direction: "OUT",
      quantity: toQty(1), unitCost: toCost(toMinor(80)), ...baseRef,
    });

    expect(result.unitCost).toBe(toCost(toMinor(80)));
    expect(result.totalCost).toBe(toMinor(80));
  });

  it("does not change the average cost when stock leaves", async () => {
    const { warehouse, product, ctx } = await stocked();
    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "SALE", direction: "OUT", quantity: toQty(9), ...baseRef,
    });
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.avgCost).toBe(toCost(toMinor(50)));
  });

  it("refuses to go negative on the damaged bucket even when the company allows negative inventory", async () => {
    const { company, warehouse, product, ctx } = await setup();
    await prisma.company.update({
      where: { id: company.id },
      data: { allowNegativeInventory: true },
    });
    await applyMovement(prisma, ctx, {
      warehouseId: warehouse.id, productId: product.id,
      movementType: "DAMAGED", direction: "IN", bucket: "DAMAGED",
      quantity: toQty(2), unitCost: toCost(toMinor(10)), ...baseRef,
    });

    await expect(
      applyMovement(prisma, ctx, {
        warehouseId: warehouse.id, productId: product.id,
        movementType: "LOST", direction: "OUT", bucket: "DAMAGED",
        quantity: toQty(5), ...baseRef,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.damagedQty).toBe(toQty(2));
  });
});

describe("applyMovement quantity guard", () => {
  beforeEach(resetDb);

  it("rejects a zero quantity and writes no movement", async () => {
    const { warehouse, product, ctx } = await setup();
    await expect(
      applyMovement(prisma, ctx, {
        warehouseId: warehouse.id, productId: product.id,
        movementType: "SALE", direction: "OUT",
        quantity: 0, ...baseRef,
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("rejects a negative quantity and writes no movement", async () => {
    const { warehouse, product, ctx } = await setup();
    await expect(
      applyMovement(prisma, ctx, {
        warehouseId: warehouse.id, productId: product.id,
        movementType: "SALE", direction: "OUT",
        quantity: toQty(-1), ...baseRef,
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });
});

describe("getBalance", () => {
  beforeEach(resetDb);

  it("creates an empty balance row on first lookup and reuses it after", async () => {
    const { company, warehouse, product } = await setup();
    const first = await getBalance(prisma, company.id, warehouse.id, product.id, null);
    const second = await getBalance(prisma, company.id, warehouse.id, product.id, null);
    expect(first.id).toBe(second.id);
    expect(first.availableQty).toBe(0);
    expect(await prisma.inventoryBalance.count()).toBe(1);
  });

  it("keeps separate balances per warehouse", async () => {
    const { company, product } = await setup();
    const other = await makeWarehouse(company.id, "WH2");
    const main = await prisma.warehouse.findFirstOrThrow({ where: { code: "MAIN", companyId: company.id } });

    await getBalance(prisma, company.id, main.id, product.id, null);
    await getBalance(prisma, company.id, other.id, product.id, null);
    expect(await prisma.inventoryBalance.count()).toBe(2);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual, issueStock, adjustStock, createTransfer, receiveTransfer } from "@/services/stock";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../tests/factories";

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const product = await makeProduct(company.id);
  const ctx = makeCtx(company.id);
  return { company, warehouse, product, ctx };
}

describe("receiveStockManual", () => {
  beforeEach(resetDb);

  it("increases stock and numbers the movement", async () => {
    const { warehouse, product, ctx } = await setup();
    const result = await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(30)), notes: "opening",
    });

    expect(result.referenceNumber).toBe("RCV-0001");
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(10));
    expect(balance.avgCost).toBe(toCost(toMinor(30)));
    expect(await prisma.auditLog.count()).toBe(1);
  });
});

describe("issueStock", () => {
  beforeEach(resetDb);

  async function stocked() {
    const s = await setup();
    await receiveStockManual(s.ctx, {
      warehouseId: s.warehouse.id, productId: s.product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(30)),
    });
    return s;
  }

  it("removes stock and records the reason as the movement type", async () => {
    const { warehouse, product, ctx } = await stocked();
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(2), reason: "INTERNAL_USE",
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(8));
    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { movementType: "INTERNAL_USE" },
    });
    expect(movement.direction).toBe("OUT");
    expect(movement.totalCost).toBe(toMinor(60));
  });

  it("moves damaged goods into the damaged bucket", async () => {
    const { warehouse, product, ctx } = await stocked();
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(3), reason: "DAMAGED",
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(7));
    expect(balance.damagedQty).toBe(toQty(3));
  });

  it("rejects an unknown reason", async () => {
    const { warehouse, product, ctx } = await stocked();
    await expect(
      issueStock(ctx, {
        warehouseId: warehouse.id, productId: product.id,
        quantity: toQty(1), reason: "BECAUSE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ISSUE_REASON" });
  });
});

describe("adjustStock", () => {
  beforeEach(resetDb);

  it("increases stock to the counted quantity", async () => {
    const { warehouse, product, ctx } = await setup();
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(20)),
    });

    const result = await adjustStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      newQuantity: toQty(12), reason: "Miscount",
    });

    expect(result.difference).toBe(toQty(2));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(12));
    expect(balance.avgCost).toBe(toCost(toMinor(20)));
    const movement = await prisma.inventoryMovement.findUniqueOrThrow({
      where: { id: result.movementId },
    });
    expect(movement.reason).toBe("Miscount");
  });

  it("decreases stock to the counted quantity", async () => {
    const { warehouse, product, ctx } = await setup();
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(20)),
    });

    const result = await adjustStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      newQuantity: toQty(7), reason: "Theft",
    });

    expect(result.difference).toBe(toQty(-3));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(7));
    await prisma.inventoryMovement.findFirstOrThrow({ where: { movementType: "ADJUSTMENT_OUT" } });
  });

  it("requires a reason", async () => {
    const { warehouse, product, ctx } = await setup();
    await expect(
      adjustStock(ctx, {
        warehouseId: warehouse.id, productId: product.id,
        newQuantity: toQty(5), reason: "  ",
      }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("does nothing when the count already matches", async () => {
    const { warehouse, product, ctx } = await setup();
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(5), unitCost: toCost(toMinor(20)),
    });
    const before = await prisma.inventoryMovement.count();

    const result = await adjustStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      newQuantity: toQty(5), reason: "Count",
    });

    expect(result.difference).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(before);
  });
});

describe("transfers", () => {
  beforeEach(resetDb);

  async function twoWarehouses() {
    const company = await makeCompany();
    const source = await makeWarehouse(company.id, "MAIN");
    const destination = await makeWarehouse(company.id, "WH2");
    const product = await makeProduct(company.id);
    const ctx = makeCtx(company.id);
    await receiveStockManual(ctx, {
      warehouseId: source.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(40)),
    });
    return { company, source, destination, product, ctx };
  }

  /** A transfer of toQty(4) already shipped and sitting IN_TRANSIT. */
  async function shipped() {
    const w = await twoWarehouses();
    const { transferId } = await createTransfer(w.ctx, {
      sourceWarehouseId: w.source.id,
      destinationWarehouseId: w.destination.id,
      lines: [{ productId: w.product.id, quantity: toQty(4) }],
    });
    const item = await prisma.warehouseTransferItem.findFirstOrThrow();
    return { ...w, transferId, item };
  }

  it("ships stock out of the source warehouse", async () => {
    const { source, destination, product, ctx } = await twoWarehouses();

    const { transferNumber } = await createTransfer(ctx, {
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      lines: [{ productId: product.id, quantity: toQty(4) }],
    });

    expect(transferNumber).toBe("TRF-0001");
    const sourceBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: source.id },
    });
    expect(sourceBalance.availableQty).toBe(toQty(6));
    const transfer = await prisma.warehouseTransfer.findFirstOrThrow();
    expect(transfer.status).toBe("IN_TRANSIT");
  });

  it("receives stock into the destination at the shipped cost", async () => {
    const { source, destination, product, ctx } = await twoWarehouses();
    const { transferId } = await createTransfer(ctx, {
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      lines: [{ productId: product.id, quantity: toQty(4) }],
    });
    const item = await prisma.warehouseTransferItem.findFirstOrThrow();

    await receiveTransfer(ctx, {
      transferId,
      lines: [{ itemId: item.id, receivedQty: toQty(4), damagedQty: 0 }],
    });

    const destBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: destination.id },
    });
    expect(destBalance.availableQty).toBe(toQty(4));
    expect(destBalance.avgCost).toBe(toCost(toMinor(40)));
    const transfer = await prisma.warehouseTransfer.findFirstOrThrow();
    expect(transfer.status).toBe("RECEIVED");
  });

  it("splits a partial receipt between available and damaged", async () => {
    const { source, destination, product, ctx } = await twoWarehouses();
    const { transferId } = await createTransfer(ctx, {
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      lines: [{ productId: product.id, quantity: toQty(4) }],
    });
    const item = await prisma.warehouseTransferItem.findFirstOrThrow();

    await receiveTransfer(ctx, {
      transferId,
      lines: [{ itemId: item.id, receivedQty: toQty(3), damagedQty: toQty(1) }],
    });

    const destBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: destination.id },
    });
    expect(destBalance.availableQty).toBe(toQty(3));
    expect(destBalance.damagedQty).toBe(toQty(1));
  });

  it("refuses to receive more than was shipped", async () => {
    const { source, destination, product, ctx } = await twoWarehouses();
    const { transferId } = await createTransfer(ctx, {
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      lines: [{ productId: product.id, quantity: toQty(4) }],
    });
    const item = await prisma.warehouseTransferItem.findFirstOrThrow();

    await expect(
      receiveTransfer(ctx, {
        transferId,
        lines: [{ itemId: item.id, receivedQty: toQty(5), damagedQty: 0 }],
      }),
    ).rejects.toMatchObject({ code: "RECEIVED_EXCEEDS_SHIPPED" });
  });

  it("rejects a transfer to the same warehouse", async () => {
    const { source, product, ctx } = await twoWarehouses();
    await expect(
      createTransfer(ctx, {
        sourceWarehouseId: source.id,
        destinationWarehouseId: source.id,
        lines: [{ productId: product.id, quantity: toQty(1) }],
      }),
    ).rejects.toMatchObject({ code: "SAME_WAREHOUSE" });
  });

  it("rejects a transfer line with a non-positive quantity", async () => {
    const { ctx, source, destination, product } = await twoWarehouses();
    await expect(
      createTransfer(ctx, {
        sourceWarehouseId: source.id, destinationWarehouseId: destination.id,
        lines: [{ productId: product.id, quantity: toQty(-1) }],
      }),
    ).rejects.toMatchObject({ code: "QUANTITY_MUST_BE_POSITIVE" });
  });

  it("rejects negative received or damaged quantities", async () => {
    const { ctx, transferId, item } = await shipped(); // toQty(4) shipped
    await expect(
      receiveTransfer(ctx, {
        transferId,
        lines: [{ itemId: item.id, receivedQty: toQty(6), damagedQty: toQty(-2) }],
      }),
    ).rejects.toMatchObject({ code: "QUANTITY_MUST_BE_NON_NEGATIVE" });
  });

  it("refuses to close a transfer that is not fully settled", async () => {
    const { ctx, transferId, item } = await shipped(); // toQty(4) shipped
    await expect(
      receiveTransfer(ctx, {
        transferId,
        lines: [{ itemId: item.id, receivedQty: toQty(2), damagedQty: 0 }],
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_NOT_FULLY_RECEIVED" });
    await expect(receiveTransfer(ctx, { transferId, lines: [] }))
      .rejects.toMatchObject({ code: "TRANSFER_NOT_FULLY_RECEIVED" });
    const t = await prisma.warehouseTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(t.status).toBe("IN_TRANSIT");
  });

  it("refuses to replay a receipt against a transfer that is already RECEIVED, without crediting the destination again", async () => {
    // receiveTransfer decrements the SOURCE at ship time (createTransfer), so
    // a regression here would double-credit the destination out of nothing:
    // the source was already debited once, and a second receipt would post a
    // second TRANSFER_IN with no matching second shipment behind it.
    const { ctx, transferId, item, destination, product } = await shipped(); // toQty(4) shipped
    await receiveTransfer(ctx, {
      transferId,
      lines: [{ itemId: item.id, receivedQty: toQty(4), damagedQty: 0 }],
    });
    const destBalanceBefore = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: destination.id, productId: product.id },
    });
    expect(destBalanceBefore.availableQty).toBe(toQty(4));
    const movementCountBefore = await prisma.inventoryMovement.count();

    await expect(
      receiveTransfer(ctx, {
        transferId,
        lines: [{ itemId: item.id, receivedQty: toQty(4), damagedQty: 0 }],
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_NOT_IN_TRANSIT" });

    // Nothing was written by the replay attempt: the destination balance and
    // the movement count are exactly what they were after the first receipt.
    const destBalanceAfter = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: destination.id, productId: product.id },
    });
    expect(destBalanceAfter.availableQty).toBe(toQty(4));
    expect(await prisma.inventoryMovement.count()).toBe(movementCountBefore);
    const t = await prisma.warehouseTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(t.status).toBe("RECEIVED");
  });

  it("rejects a receipt with two lines for the same transfer item, before anything is written", async () => {
    const { ctx, transferId, item, destination, product } = await shipped(); // toQty(4) shipped

    await expect(
      receiveTransfer(ctx, {
        transferId,
        lines: [
          { itemId: item.id, receivedQty: toQty(2), damagedQty: 0 },
          { itemId: item.id, receivedQty: toQty(2), damagedQty: 0 },
        ],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_TRANSFER_LINE" });

    expect(await prisma.inventoryMovement.count({ where: { movementType: "TRANSFER_IN" } })).toBe(0);
    const destBalance = await prisma.inventoryBalance.findFirst({
      where: { warehouseId: destination.id, productId: product.id },
    });
    expect(destBalance).toBeNull();
    const t = await prisma.warehouseTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(t.status).toBe("IN_TRANSIT");
    const unchangedItem = await prisma.warehouseTransferItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchangedItem.receivedQty).toBe(0);
    expect(unchangedItem.damagedQty).toBe(0);
  });

  it("rejects a receipt line referencing an item that doesn't belong to the transfer, before anything is written", async () => {
    const { ctx, transferId, item, destination, product } = await shipped(); // toQty(4) shipped

    await expect(
      receiveTransfer(ctx, {
        transferId,
        lines: [{ itemId: "nonexistent-item-id", receivedQty: toQty(4), damagedQty: 0 }],
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_ITEM_NOT_FOUND" });

    expect(await prisma.inventoryMovement.count({ where: { movementType: "TRANSFER_IN" } })).toBe(0);
    const destBalance = await prisma.inventoryBalance.findFirst({
      where: { warehouseId: destination.id, productId: product.id },
    });
    expect(destBalance).toBeNull();
    const t = await prisma.warehouseTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(t.status).toBe("IN_TRANSIT");
    const unchangedItem = await prisma.warehouseTransferItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchangedItem.receivedQty).toBe(0);
  });
});

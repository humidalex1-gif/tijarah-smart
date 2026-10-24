import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { MovementType } from "@/lib/constants";
import { applyMovement, getBalance } from "@/services/inventory";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";
import { ServiceError, invalidState } from "@/services/errors";

const ISSUE_REASONS: Record<string, { type: MovementType; bucket?: "DAMAGED" }> = {
  INTERNAL_USE: { type: "INTERNAL_USE" },
  PROMOTIONAL_USE: { type: "PROMOTIONAL_USE" },
  LOST: { type: "LOST" },
  DAMAGED: { type: "DAMAGED", bucket: "DAMAGED" },
};

export async function receiveStockManual(
  ctx: ServiceContext,
  input: {
    warehouseId: string; productId: string; variantId?: string | null;
    quantity: number; unitCost: number; reason?: string; notes?: string;
  },
) {
  if (input.quantity <= 0) throw invalidState("QUANTITY_MUST_BE_POSITIVE");

  return prisma.$transaction(async (tx) => {
    const referenceNumber = await nextNumber(tx, ctx.companyId, "RCV");
    const movementRef = crypto.randomUUID();

    await applyMovement(tx, ctx, {
      warehouseId: input.warehouseId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      movementType: "ADJUSTMENT_IN",
      direction: "IN",
      quantity: input.quantity,
      unitCost: input.unitCost,
      referenceType: "MANUAL_RECEIPT",
      referenceId: movementRef,
      referenceNumber,
      reason: input.reason ?? "Manual receipt",
      notes: input.notes ?? null,
    });

    const movement = await tx.inventoryMovement.findFirstOrThrow({
      where: { referenceId: movementRef },
    });

    await writeAudit(tx, ctx, {
      action: "STOCK_RECEIVED",
      entityType: "InventoryMovement",
      entityId: movement.id,
      newValues: {
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: input.quantity,
        unitCost: input.unitCost,
      },
    });

    return { movementId: movement.id, referenceNumber };
  });
}

export async function issueStock(
  ctx: ServiceContext,
  input: {
    warehouseId: string; productId: string; variantId?: string | null;
    quantity: number; reason: string; notes?: string;
  },
) {
  const mapping = ISSUE_REASONS[input.reason];
  if (!mapping) throw new ServiceError("INVALID_ISSUE_REASON", { reason: input.reason });
  if (input.quantity <= 0) throw invalidState("QUANTITY_MUST_BE_POSITIVE");

  return prisma.$transaction(async (tx) => {
    const referenceNumber = await nextNumber(tx, ctx.companyId, "ISS");
    const movementRef = crypto.randomUUID();

    // Damaged goods leave available stock and land in the damaged bucket,
    // so they stay on the books until they are scrapped or sold off.
    const out = await applyMovement(tx, ctx, {
      warehouseId: input.warehouseId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      movementType: mapping.type,
      direction: "OUT",
      quantity: input.quantity,
      referenceType: "STOCK_ISSUE",
      referenceId: movementRef,
      referenceNumber,
      reason: input.reason,
      notes: input.notes ?? null,
    });

    if (mapping.bucket === "DAMAGED") {
      await applyMovement(tx, ctx, {
        warehouseId: input.warehouseId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        movementType: "DAMAGED",
        direction: "IN",
        bucket: "DAMAGED",
        quantity: input.quantity,
        unitCost: out.unitCost,
        referenceType: "STOCK_ISSUE",
        referenceId: movementRef,
        referenceNumber,
        reason: input.reason,
      });
    }

    const movement = await tx.inventoryMovement.findFirstOrThrow({
      where: { referenceId: movementRef, direction: "OUT" },
    });

    await writeAudit(tx, ctx, {
      action: "STOCK_ISSUED",
      entityType: "InventoryMovement",
      entityId: movement.id,
      newValues: { reason: input.reason, quantity: input.quantity },
    });

    return { movementId: movement.id, referenceNumber };
  });
}

export async function adjustStock(
  ctx: ServiceContext,
  input: {
    warehouseId: string; productId: string; variantId?: string | null;
    newQuantity: number; reason: string; notes?: string;
  },
) {
  if (!input.reason || input.reason.trim() === "") {
    throw new ServiceError("REASON_REQUIRED");
  }

  return prisma.$transaction(async (tx) => {
    const balance = await getBalance(
      tx, ctx.companyId, input.warehouseId, input.productId, input.variantId ?? null,
    );
    const difference = input.newQuantity - balance.availableQty;
    if (difference === 0) return { movementId: "", difference: 0 };

    const referenceNumber = await nextNumber(tx, ctx.companyId, "ADJ");
    const movementRef = crypto.randomUUID();

    await applyMovement(tx, ctx, {
      warehouseId: input.warehouseId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      movementType: difference > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
      direction: difference > 0 ? "IN" : "OUT",
      quantity: Math.abs(difference),
      // An increase with no known cost is valued at the current average.
      unitCost: balance.avgCost,
      referenceType: "STOCK_ADJUSTMENT",
      referenceId: movementRef,
      referenceNumber,
      reason: input.reason,
      notes: input.notes ?? null,
    });

    const movement = await tx.inventoryMovement.findFirstOrThrow({
      where: { referenceId: movementRef },
    });

    await writeAudit(tx, ctx, {
      action: "STOCK_ADJUSTED",
      entityType: "InventoryMovement",
      entityId: movement.id,
      oldValues: { availableQty: balance.availableQty },
      newValues: { availableQty: input.newQuantity, reason: input.reason },
    });

    return { movementId: movement.id, difference };
  });
}

export async function createTransfer(
  ctx: ServiceContext,
  input: {
    sourceWarehouseId: string;
    destinationWarehouseId: string;
    lines: { productId: string; variantId?: string | null; quantity: number }[];
    notes?: string;
  },
) {
  if (input.sourceWarehouseId === input.destinationWarehouseId) {
    throw new ServiceError("SAME_WAREHOUSE");
  }
  if (input.lines.length === 0) throw invalidState("NO_LINES");
  for (const line of input.lines) {
    // applyMovement documents `quantity` as positive but does not enforce it:
    // a negative OUT quantity slips past the stock check and adds stock.
    if (line.quantity <= 0) {
      throw invalidState("QUANTITY_MUST_BE_POSITIVE", { productId: line.productId });
    }
  }

  return prisma.$transaction(async (tx) => {
    const transferNumber = await nextNumber(tx, ctx.companyId, "TRF");
    const transfer = await tx.warehouseTransfer.create({
      data: {
        companyId: ctx.companyId,
        transferNumber,
        sourceWarehouseId: input.sourceWarehouseId,
        destinationWarehouseId: input.destinationWarehouseId,
        status: "IN_TRANSIT",
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    for (const line of input.lines) {
      const out = await applyMovement(tx, ctx, {
        warehouseId: input.sourceWarehouseId,
        destinationWarehouseId: input.destinationWarehouseId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        movementType: "TRANSFER_OUT",
        direction: "OUT",
        quantity: line.quantity,
        referenceType: "WAREHOUSE_TRANSFER",
        referenceId: transfer.id,
        referenceNumber: transferNumber,
      });

      await tx.warehouseTransferItem.create({
        data: {
          transferId: transfer.id,
          productId: line.productId,
          variantId: line.variantId ?? null,
          shippedQty: line.quantity,
          unitCost: out.unitCost,
        },
      });
    }

    await writeAudit(tx, ctx, {
      action: "TRANSFER_SHIPPED",
      entityType: "WarehouseTransfer",
      entityId: transfer.id,
      newValues: { transferNumber, lines: input.lines.length },
    });

    return { transferId: transfer.id, transferNumber };
  });
}

export async function receiveTransfer(
  ctx: ServiceContext,
  input: { transferId: string; lines: { itemId: string; receivedQty: number; damagedQty: number }[] },
) {
  return prisma.$transaction(async (tx) => {
    const transfer = await tx.warehouseTransfer.findFirstOrThrow({
      where: { id: input.transferId, companyId: ctx.companyId },
      include: { items: true },
    });
    if (transfer.status !== "IN_TRANSIT") throw invalidState("TRANSFER_NOT_IN_TRANSIT");

    // Validate the whole payload before writing anything. Quantities must be
    // non-negative (a negative damagedQty would defeat the sum check below and
    // fabricate stock), each item may appear at most once, and every shipped
    // item must be fully settled — the source was decremented at ship time, so
    // an unsettled remainder would leave the system with no record of it.
    const settled = new Map<string, number>();
    for (const line of input.lines) {
      if (line.receivedQty < 0 || line.damagedQty < 0) {
        throw invalidState("QUANTITY_MUST_BE_NON_NEGATIVE", { itemId: line.itemId });
      }
      if (settled.has(line.itemId)) {
        throw invalidState("DUPLICATE_TRANSFER_LINE", { itemId: line.itemId });
      }
      const item = transfer.items.find((i) => i.id === line.itemId);
      if (!item) throw invalidState("TRANSFER_ITEM_NOT_FOUND", { itemId: line.itemId });

      const total = line.receivedQty + line.damagedQty;
      if (total > item.shippedQty) {
        throw new ServiceError("RECEIVED_EXCEEDS_SHIPPED", {
          itemId: item.id, shipped: item.shippedQty, received: total,
        });
      }
      settled.set(line.itemId, total);
    }
    for (const item of transfer.items) {
      const total = settled.get(item.id) ?? 0;
      if (total !== item.shippedQty) {
        throw invalidState("TRANSFER_NOT_FULLY_RECEIVED", {
          itemId: item.id, shipped: item.shippedQty, settled: total,
        });
      }
    }

    for (const line of input.lines) {
      const item = transfer.items.find((i) => i.id === line.itemId)!;

      if (line.receivedQty > 0) {
        await applyMovement(tx, ctx, {
          warehouseId: transfer.destinationWarehouseId,
          productId: item.productId,
          variantId: item.variantId,
          movementType: "TRANSFER_IN",
          direction: "IN",
          quantity: line.receivedQty,
          unitCost: item.unitCost,
          referenceType: "WAREHOUSE_TRANSFER",
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
        });
      }

      if (line.damagedQty > 0) {
        await applyMovement(tx, ctx, {
          warehouseId: transfer.destinationWarehouseId,
          productId: item.productId,
          variantId: item.variantId,
          movementType: "DAMAGED",
          direction: "IN",
          bucket: "DAMAGED",
          quantity: line.damagedQty,
          unitCost: item.unitCost,
          referenceType: "WAREHOUSE_TRANSFER",
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
          reason: "Damaged in transit",
        });
      }

      await tx.warehouseTransferItem.update({
        where: { id: item.id },
        data: { receivedQty: line.receivedQty, damagedQty: line.damagedQty },
      });
    }

    await tx.warehouseTransfer.update({
      where: { id: transfer.id },
      data: { status: "RECEIVED", receivedAt: new Date() },
    });

    await writeAudit(tx, ctx, {
      action: "TRANSFER_RECEIVED",
      entityType: "WarehouseTransfer",
      entityId: transfer.id,
      newValues: { lines: input.lines.length },
    });
  });
}

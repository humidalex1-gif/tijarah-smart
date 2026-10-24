import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { ALLOCATION_METHODS, type AllocationMethod } from "@/lib/constants";
import { applyPct, QTY_SCALE } from "@/lib/money";
import { allocateCost, landedUnitCost, type AllocationLine } from "@/services/costing";
import { applyMovement } from "@/services/inventory";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";
import { appendSupplierLedger } from "@/services/ledger";
import { ServiceError, invalidState } from "@/services/errors";

/**
 * Round `total` pro-rata against cumulative received quantity, exact at
 * completion (cumulativeQty >= orderedQty returns total unrounded). Purely a
 * function of the cumulative quantity, so no accumulator needs to be stored:
 * f(after) - f(before) telescopes to `total` across any receipt sequence
 * that completes the line, regardless of how many partial receipts land in
 * between.
 */
function telescopedShare(total: number, cumulativeQty: number, orderedQty: number): number {
  if (orderedQty === 0) return 0;
  return cumulativeQty >= orderedQty ? total : Math.round((total * cumulativeQty) / orderedQty);
}

export async function createPurchaseOrder(
  ctx: ServiceContext,
  input: {
    supplierId: string;
    warehouseId: string;
    orderDate?: Date;
    expectedDate?: Date | null;
    allocationMethod?: AllocationMethod;
    notes?: string;
    items: {
      productId: string; variantId?: string | null;
      orderedQty: number; unitPrice: number;
      discountAmount?: number; taxRatePct?: number;
    }[];
    additionalCosts?: { costType: string; description?: string; amount: number }[];
  },
) {
  if (input.items.length === 0) throw new ServiceError("NO_LINES");
  // Unknown strings could arrive from a raw-JSON caller without their own
  // validation (same reasoning as the Role guard in accounts.ts); MANUAL gets
  // its own, more specific rejection below.
  if (input.allocationMethod !== undefined) {
    if (!(ALLOCATION_METHODS as readonly string[]).includes(input.allocationMethod)) {
      throw invalidState("INVALID_ALLOCATION_METHOD", { method: input.allocationMethod });
    }
    if (input.allocationMethod === "MANUAL") {
      // No storage for manual splits until Stage 2 — silently equal-splitting
      // a merchant's freight/customs is worse than refusing outright.
      throw invalidState("MANUAL_ALLOCATION_NOT_SUPPORTED");
    }
  }
  for (const item of input.items) {
    if (item.orderedQty <= 0) {
      throw invalidState("QUANTITY_MUST_BE_POSITIVE", { productId: item.productId });
    }
    if (item.unitPrice < 0) {
      throw invalidState("INVALID_PRICE", { productId: item.productId });
    }
    const gross = Math.round((item.orderedQty * item.unitPrice) / QTY_SCALE);
    const discountAmount = item.discountAmount ?? 0;
    if (discountAmount < 0 || discountAmount > gross) {
      throw invalidState("INVALID_DISCOUNT", { productId: item.productId });
    }
    if (item.taxRatePct !== undefined && item.taxRatePct < 0) {
      throw invalidState("INVALID_TAX_RATE", { productId: item.productId });
    }
  }
  for (const cost of input.additionalCosts ?? []) {
    if (cost.amount < 0) {
      throw invalidState("INVALID_COST_AMOUNT", { costType: cost.costType });
    }
  }

  return prisma.$transaction(async (tx) => {
    await tx.supplier.findFirstOrThrow({
      where: { id: input.supplierId, companyId: ctx.companyId },
    });
    await tx.warehouse.findFirstOrThrow({
      where: { id: input.warehouseId, companyId: ctx.companyId },
    });

    const purchaseOrderNumber = await nextNumber(tx, ctx.companyId, "PO");

    const lines = input.items.map((item) => {
      // unitPrice is minor units per whole unit; orderedQty is scaled by QTY_SCALE.
      const gross = Math.round((item.orderedQty * item.unitPrice) / QTY_SCALE);
      const lineTotal = gross - (item.discountAmount ?? 0);
      const taxAmount = applyPct(lineTotal, item.taxRatePct ?? 0);
      return { ...item, lineTotal, taxAmount };
    });

    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const discountTotal = input.items.reduce((sum, i) => sum + (i.discountAmount ?? 0), 0);
    const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0);
    const additionalCostTotal = (input.additionalCosts ?? []).reduce((s, c) => s + c.amount, 0);
    const grandTotal = subtotal + taxTotal + additionalCostTotal;

    const po = await tx.purchaseOrder.create({
      data: {
        companyId: ctx.companyId,
        purchaseOrderNumber,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        orderDate: input.orderDate ?? new Date(),
        expectedDate: input.expectedDate ?? null,
        allocationMethod: input.allocationMethod ?? "VALUE",
        subtotal,
        discountTotal,
        taxTotal,
        additionalCostTotal,
        grandTotal,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    for (const line of lines) {
      await tx.purchaseOrderItem.create({
        data: {
          purchaseOrderId: po.id,
          productId: line.productId,
          variantId: line.variantId ?? null,
          orderedQty: line.orderedQty,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount ?? 0,
          taxAmount: line.taxAmount,
          lineTotal: line.lineTotal,
        },
      });
    }

    for (const cost of input.additionalCosts ?? []) {
      await tx.purchaseAdditionalCost.create({
        data: {
          purchaseOrderId: po.id,
          costType: cost.costType,
          description: cost.description ?? null,
          amount: cost.amount,
        },
      });
    }

    await writeAudit(tx, ctx, {
      action: "PURCHASE_ORDER_CREATED",
      entityType: "PurchaseOrder",
      entityId: po.id,
      newValues: { purchaseOrderNumber, grandTotal },
    });

    return { purchaseOrderId: po.id, purchaseOrderNumber, grandTotal };
  });
}

export async function confirmPurchaseOrder(ctx: ServiceContext, purchaseOrderId: string) {
  await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirstOrThrow({
      where: { id: purchaseOrderId, companyId: ctx.companyId },
    });
    if (po.status !== "DRAFT") throw invalidState("PURCHASE_ORDER_NOT_DRAFT");

    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "CONFIRMED" },
    });

    await writeAudit(tx, ctx, {
      action: "PURCHASE_ORDER_CONFIRMED",
      entityType: "PurchaseOrder",
      entityId: po.id,
      oldValues: { status: po.status },
      newValues: { status: "CONFIRMED" },
    });
  });
}

export async function receivePurchase(
  ctx: ServiceContext,
  input: {
    purchaseOrderId: string;
    receivedDate?: Date;
    notes?: string;
    lines: { purchaseOrderItemId: string; acceptedQty: number; damagedQty?: number }[];
  },
) {
  if (input.lines.length === 0) throw new ServiceError("NO_LINES");
  // Two lines for the same item would each validate against the same stale
  // receivedQty snapshot, bypassing the over-receipt guard.
  const seenItems = new Set<string>();
  for (const l of input.lines) {
    if (seenItems.has(l.purchaseOrderItemId)) {
      throw new ServiceError("DUPLICATE_RECEIPT_LINE", { itemId: l.purchaseOrderItemId });
    }
    seenItems.add(l.purchaseOrderItemId);
  }
  for (const l of input.lines) {
    const damagedQty = l.damagedQty ?? 0;
    if (l.acceptedQty < 0 || damagedQty < 0) {
      throw invalidState("QUANTITY_MUST_BE_NON_NEGATIVE", { itemId: l.purchaseOrderItemId });
    }
    if (l.acceptedQty + damagedQty === 0) {
      throw new ServiceError("EMPTY_RECEIPT_LINE", { itemId: l.purchaseOrderItemId });
    }
  }

  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirstOrThrow({
      where: { id: input.purchaseOrderId, companyId: ctx.companyId },
      include: { items: { include: { product: true } }, additionalCosts: true },
    });
    if (po.status !== "CONFIRMED") throw new ServiceError("PURCHASE_ORDER_NOT_CONFIRMED");

    // Pair each requested line with its order item and validate quantities.
    const receiving = input.lines.map((line) => {
      const item = po.items.find((i) => i.id === line.purchaseOrderItemId);
      if (!item) throw invalidState("PURCHASE_ITEM_NOT_FOUND", { id: line.purchaseOrderItemId });

      const receivedNow = line.acceptedQty + (line.damagedQty ?? 0);
      if (item.receivedQty + receivedNow > item.orderedQty) {
        throw new ServiceError("RECEIVED_EXCEEDS_ORDERED", {
          itemId: item.id, ordered: item.orderedQty,
          alreadyReceived: item.receivedQty, requested: receivedNow,
        });
      }

      // Telescoping pro-rata: each component (undiscounted gross, discount,
      // tax) is rounded independently against cumulative received quantity,
      // and this receipt takes the difference between the cumulative share
      // after and before. Because telescopedShare(X, orderedQty, orderedQty)
      // == X exactly, the slices across ANY receipt sequence that completes
      // the line sum to exactly X for each component — no stored
      // accumulator, no drift. baseLineCost = grossSlice - discountSlice
      // telescopes to lineTotal because gross and discount are each their
      // own exact telescoping sum over the same cumulative-quantity
      // denominator (orderedQty), so the difference of two exact sums is
      // exact too.
      const receivedBefore = item.receivedQty;
      const receivedAfter = receivedBefore + receivedNow;
      const grossTotal = item.lineTotal + item.discountAmount; // undiscounted gross, exact
      const grossSlice =
        telescopedShare(grossTotal, receivedAfter, item.orderedQty) -
        telescopedShare(grossTotal, receivedBefore, item.orderedQty);
      const discountSlice =
        telescopedShare(item.discountAmount, receivedAfter, item.orderedQty) -
        telescopedShare(item.discountAmount, receivedBefore, item.orderedQty);
      const taxSlice =
        telescopedShare(item.taxAmount, receivedAfter, item.orderedQty) -
        telescopedShare(item.taxAmount, receivedBefore, item.orderedQty);
      const baseLineCost = grossSlice - discountSlice;

      return { line, item, receivedNow, baseLineCost, taxSlice };
    });

    // Allocate the order's additional costs across ALL ordered lines, once and
    // deterministically. Allocating over "the lines being received" instead
    // would re-book the whole freight/customs total on every partial receipt.
    const additionalTotal = po.additionalCosts.reduce((s, c) => s + c.amount, 0);
    const allocationLines: AllocationLine[] = po.items.map((i) => ({
      quantity: i.orderedQty,
      lineValue: i.lineTotal, // already net of the line discount
      weightGrams: i.product.weightGrams,
    }));
    const orderAllocations = allocateCost(
      additionalTotal,
      po.allocationMethod as AllocationMethod,
      allocationLines,
    );
    const allocationByItemId = new Map(
      po.items.map((i, idx) => [i.id, orderAllocations[idx]]),
    );

    const receiptNumber = await nextNumber(tx, ctx.companyId, "RCP");
    const receipt = await tx.purchaseReceipt.create({
      data: {
        companyId: ctx.companyId,
        purchaseOrderId: po.id,
        receiptNumber,
        warehouseId: po.warehouseId,
        receivedDate: input.receivedDate ?? new Date(),
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    let goodsValue = 0;

    for (const { line, item, receivedNow, baseLineCost } of receiving) {
      const lineTotalAllocation = allocationByItemId.get(item.id) ?? 0;
      const totalReceivedAfter = item.receivedQty + receivedNow;
      // Capitalise only this receipt's pro-rata slice; on the final receipt for
      // a line take the exact remainder so rounding crumbs are neither lost nor
      // double-counted. The accumulator converges to lineTotalAllocation and
      // can never exceed it.
      const allocated =
        item.orderedQty === 0
          ? 0
          : (totalReceivedAfter >= item.orderedQty
              ? lineTotalAllocation
              : Math.round((lineTotalAllocation * totalReceivedAfter) / item.orderedQty)
            ) - item.allocatedAdditionalCost;
      const unitCost = landedUnitCost(baseLineCost, allocated, receivedNow);
      const acceptedQty = line.acceptedQty;
      const damagedQty = line.damagedQty ?? 0;

      if (acceptedQty > 0) {
        await applyMovement(tx, ctx, {
          warehouseId: po.warehouseId,
          productId: item.productId,
          variantId: item.variantId,
          movementType: "PURCHASE_RECEIPT",
          direction: "IN",
          quantity: acceptedQty,
          unitCost,
          referenceType: "PURCHASE_RECEIPT",
          referenceId: receipt.id,
          referenceNumber: receiptNumber,
        });
      }

      if (damagedQty > 0) {
        await applyMovement(tx, ctx, {
          warehouseId: po.warehouseId,
          productId: item.productId,
          variantId: item.variantId,
          movementType: "DAMAGED",
          direction: "IN",
          bucket: "DAMAGED",
          quantity: damagedQty,
          unitCost,
          referenceType: "PURCHASE_RECEIPT",
          referenceId: receipt.id,
          referenceNumber: receiptNumber,
          reason: "Damaged on arrival",
        });
      }

      await tx.purchaseReceiptItem.create({
        data: {
          receiptId: receipt.id,
          purchaseOrderItemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          acceptedQty,
          damagedQty,
          landedUnitCost: unitCost,
        },
      });

      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: {
          receivedQty: item.receivedQty + receivedNow,
          allocatedAdditionalCost: item.allocatedAdditionalCost + allocated,
          landedUnitCost: unitCost,
        },
      });

      goodsValue += baseLineCost;
    }

    // Tax on the goods received is part of what we owe the supplier. Each
    // receipt's slice comes straight from the telescoping split above, so
    // this sums to item.taxAmount exactly once a line is fully received.
    const taxOnReceived = receiving.reduce((sum, r) => sum + r.taxSlice, 0);

    await appendSupplierLedger(tx, ctx, {
      supplierId: po.supplierId,
      transactionType: "GOODS_RECEIVED",
      referenceType: "PURCHASE_ORDER",
      referenceId: po.id,
      referenceNumber: po.purchaseOrderNumber,
      creditAmount: goodsValue + taxOnReceived,
    });

    const refreshed = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId: po.id },
    });
    const fullyReceived = refreshed.every((i) => i.receivedQty >= i.orderedQty);
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { receivingStatus: fullyReceived ? "RECEIVED" : "PARTIAL" },
    });

    await writeAudit(tx, ctx, {
      action: "PURCHASE_RECEIVED",
      entityType: "PurchaseReceipt",
      entityId: receipt.id,
      newValues: { receiptNumber, lines: input.lines.length, goodsValue },
    });

    return { receiptId: receipt.id, receiptNumber };
  });
}

export async function cancelPurchaseOrder(
  ctx: ServiceContext,
  purchaseOrderId: string,
  reason: string,
) {
  await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirstOrThrow({
      where: { id: purchaseOrderId, companyId: ctx.companyId },
      include: { items: true },
    });
    if (po.items.some((i) => i.receivedQty > 0)) {
      throw new ServiceError("PURCHASE_ALREADY_RECEIVED");
    }
    if (po.status === "CANCELLED") throw invalidState("ALREADY_CANCELLED");

    const notes = po.notes ? `${po.notes} | CANCELLED: ${reason}` : reason;
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "CANCELLED", notes },
    });

    await writeAudit(tx, ctx, {
      action: "PURCHASE_ORDER_CANCELLED",
      entityType: "PurchaseOrder",
      entityId: po.id,
      oldValues: { status: po.status },
      newValues: { status: "CANCELLED", reason },
    });
  });
}

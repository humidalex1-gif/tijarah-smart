import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { applyMovement } from "@/services/inventory";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";

/**
 * Repairs the opening balance when orders older than it were imported on top.
 *
 * Fast Hub's counts are net of every shipment they have already made. Seeding
 * the books from a count taken on 2026-08-04 and then importing orders back to
 * 2026-05-10 deducted the same units twice: 29 of them, across 8 SKUs, stood
 * on the shelf while the books called them sold.
 *
 * The fix is NOT to reset the balances. Read the ledger honestly and it says
 * something narrower: those units were bought, held and sold, and the books
 * never recorded receiving them. So the opening balance was simply taken too
 * late. This adds the missing opening receipt, dated before the earliest such
 * order — which is what the opening balance should have said all along, and
 * leaves the sales, their cost and the profit exactly as they are.
 *
 * It needs no idempotency key. The correction is dated BEFORE the orders it
 * accounts for, so a second run finds those orders on the safe side of the
 * boundary and computes a correction of zero. The arithmetic closes itself.
 */

export type OpeningCorrectionLine = {
  productId: string;
  sku: string;
  /** Units to add back, in thousandths: what was sold before the count. */
  quantity: number;
  /** The opening import's own unit cost, so the average does not move. */
  unitCost: number;
  /** The opening balance date that proved to be too late. */
  openedAt: Date;
  /** Where the corrected opening balance is dated instead. */
  asOf: Date;
};

export type OpeningCorrectionReport = {
  lines: OpeningCorrectionLine[];
  /** Total units added back, in thousandths. */
  totalQuantity: number;
};

/**
 * Works out the correction without writing anything, so it can be printed and
 * read before it is believed.
 */
export async function planOpeningCorrection(
  ctx: ServiceContext,
  input: { warehouseId: string },
): Promise<OpeningCorrectionReport> {
  // Tenant gate: a foreign warehouse resolves to nothing, never to everything.
  await prisma.warehouse.findFirstOrThrow({
    where: { id: input.warehouseId, companyId: ctx.companyId },
  });

  // Only AVAILABLE openings matter. Damaged units were never sellable, so no
  // sale can have deducted them.
  const openings = await prisma.inventoryMovement.findMany({
    where: {
      companyId: ctx.companyId,
      warehouseId: input.warehouseId,
      referenceType: "FASTHUB_IMPORT",
      bucket: "AVAILABLE",
      direction: "IN",
    },
    select: { productId: true, movementDate: true, unitCost: true },
    orderBy: { movementDate: "asc" },
  });
  if (openings.length === 0) return { lines: [], totalQuantity: 0 };

  // Earliest wins: it is the boundary the orders poller enforces, and after
  // one correction it is the correction's own date.
  const openedAt = new Map<string, { at: Date; unitCost: number }>();
  for (const row of openings) {
    if (!openedAt.has(row.productId)) {
      openedAt.set(row.productId, { at: row.movementDate, unitCost: row.unitCost });
    }
  }

  // Both legs, netted below. A cancellation puts the units back, so counting
  // the sale and ignoring its reversal would add them a second time — the very
  // error being repaired, committed by the repair.
  const sales = await prisma.inventoryMovement.findMany({
    where: {
      companyId: ctx.companyId,
      warehouseId: input.warehouseId,
      referenceType: { in: ["SALES_ORDER", "SALES_ORDER_CANCELLATION"] },
      bucket: "AVAILABLE",
      productId: { in: [...openedAt.keys()] },
    },
    select: { productId: true, quantity: true, referenceId: true, direction: true },
  });
  if (sales.length === 0) return { lines: [], totalQuantity: 0 };

  // The movement's own date is when the SYNC ran, not when the goods left, so
  // it says nothing about whether the count already reflected them. The order's
  // date does.
  const orders = await prisma.salesOrder.findMany({
    where: { companyId: ctx.companyId, id: { in: [...new Set(sales.map((s) => s.referenceId))] } },
    select: { id: true, orderDate: true },
  });
  const orderDates = new Map(orders.map((o) => [o.id, o.orderDate]));

  const missing = new Map<string, number>();
  let earliestOrder: Date | null = null;
  for (const sale of sales) {
    const opening = openedAt.get(sale.productId);
    const orderDate = orderDates.get(sale.referenceId);
    if (!opening || !orderDate) continue;
    if (orderDate >= opening.at) continue;
    const signed = sale.direction === "OUT" ? sale.quantity : -sale.quantity;
    missing.set(sale.productId, (missing.get(sale.productId) ?? 0) + signed);
    if (!earliestOrder || orderDate < earliestOrder) earliestOrder = orderDate;
  }
  // A product whose pre-opening sales all came back is owed nothing, and a
  // negative correction would be an OUT movement dressed as a repair.
  for (const [productId, quantity] of missing) {
    if (quantity <= 0) missing.delete(productId);
  }
  if (!earliestOrder || missing.size === 0) return { lines: [], totalQuantity: 0 };

  // One date for the whole correction, the day before the earliest order it
  // accounts for. Per-product dates would be a touch tighter as a guard, but
  // "the opening balance is as of this day" is a single fact about the
  // warehouse and reads as one in the ledger.
  const asOf = new Date(earliestOrder.getTime() - 24 * 60 * 60 * 1000);

  const products = await prisma.product.findMany({
    where: { companyId: ctx.companyId, id: { in: [...missing.keys()] } },
    select: { id: true, sku: true },
  });
  const skuById = new Map(products.map((p) => [p.id, p.sku]));

  const lines: OpeningCorrectionLine[] = [...missing.entries()]
    .map(([productId, quantity]) => ({
      productId,
      sku: skuById.get(productId) ?? productId,
      quantity,
      unitCost: openedAt.get(productId)!.unitCost,
      openedAt: openedAt.get(productId)!.at,
      asOf,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  return { lines, totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0) };
}

export async function applyOpeningCorrection(
  ctx: ServiceContext,
  input: { warehouseId: string },
): Promise<OpeningCorrectionReport> {
  const plan = await planOpeningCorrection(ctx, input);

  for (const line of plan.lines) {
    // One transaction per product, as the opening import itself does: one bad
    // row must not discard the rest of a whole-catalogue correction.
    await prisma.$transaction(async (tx) => {
      const referenceNumber = await nextNumber(tx, ctx.companyId, "FHI");
      await applyMovement(tx, ctx, {
        warehouseId: input.warehouseId,
        productId: line.productId,
        variantId: null,
        movementType: "ADJUSTMENT_IN",
        direction: "IN",
        bucket: "AVAILABLE",
        quantity: line.quantity,
        unitCost: line.unitCost,
        referenceType: "FASTHUB_IMPORT",
        referenceId: line.productId,
        referenceNumber,
        reason: "Opening balance correction: units sold before the opening count",
        movementDate: line.asOf,
      });
      await writeAudit(tx, ctx, {
        action: "FASTHUB_OPENING_CORRECTION",
        entityType: "Product",
        entityId: line.productId,
        newValues: {
          sku: line.sku,
          quantity: line.quantity,
          openedAt: line.openedAt.toISOString(),
          asOf: line.asOf.toISOString(),
        },
      });
    });
  }

  return plan;
}

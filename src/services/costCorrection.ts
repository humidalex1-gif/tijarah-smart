import { prisma } from "@/lib/db";
import { costOf } from "@/lib/money";
import type { ServiceContext } from "@/services/context";
import { applyMovement } from "@/services/inventory";
import { recomputeOrderCostAllocation } from "@/services/sales";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";

/**
 * Puts a real cost on stock that was opened at zero, and on the orders that
 * already sold it.
 *
 * The owner's costing sheet did not price six of the products, and
 * `importFastHubOpeningStock` books everything at cost 0, so their opening
 * receipt landed at zero. A weighted average cannot be nudged off that: an IN
 * of quantity 0 leaves it untouched and an IN of quantity > 0 invents stock.
 * Three of the six had already sold, and those orders report gross profit
 * equal to revenue — 45.4% of all revenue at 100% margin.
 *
 * Two halves, and they are genuinely separate problems:
 *
 * - **Stock still on the shelf** is revalued by an ADJUSTMENT_OUT of every
 *   available unit at the old cost followed by an ADJUSTMENT_IN of the same
 *   quantity at the true one. Quantity nets to zero, and because the IN
 *   averages into an emptied balance, `newAverageCost` lands exactly on the
 *   new figure. The arithmetic is the tested path; this adds no new writer of
 *   `avgCost`.
 * - **Units already sold** are not on the shelf to reprice, so their cost is
 *   corrected on the ORDER — the snapshot, its line, and the order's rollup —
 *   and the allocation is recomputed so net profit follows gross.
 *
 * The ledger is appended to, never rewritten: the original zero-cost movements
 * stand, and the revaluation is its own dated, audited pair.
 */

/** Its own reference type, and that is load-bearing rather than tidy.
 *
 * Three readers filter `InventoryMovement` by `referenceType`, and reusing an
 * existing one corrupts each of them silently: `openingBalanceDates` would move
 * the pre-opening boundary that the orders poller enforces, `planOpeningCorrection`
 * would read a revaluation as an opening receipt, and the shrinkage report
 * would count a revaluation leg as a loss. */
const REVALUATION = "COST_REVALUATION";

export type CostInput = { sku: string; unitCost: number };

export type RestatedOrder = {
  salesOrderId: string;
  salesOrderNumber: string;
  /** Units on this order, in thousandths. */
  quantity: number;
  /** Minor units of COGS the restatement adds to the order. */
  addedCost: number;
};

export type CostCorrectionLine = {
  productId: string;
  sku: string;
  /** The true cost, ×10 000. */
  unitCost: number;
  /** Available units revalued, in thousandths. Zero when none are on hand. */
  revaluedQty: number;
  restatedOrders: RestatedOrder[];
};

export type CostCorrectionReport = {
  lines: CostCorrectionLine[];
  /** SKUs named in the input that no product matches. */
  unknownSkus: string[];
  /** Products already carrying a cost, left alone. */
  skipped: { sku: string; reason: "ALREADY_COSTED" }[];
  /** Minor units of COGS added across every restated order. */
  totalCostAdded: number;
};

type Resolved = {
  productId: string;
  sku: string;
  unitCost: number;
  availableQty: number;
  balanceId: string | null;
};

async function resolve(
  ctx: ServiceContext,
  input: { warehouseId: string; costs: CostInput[] },
): Promise<{ resolved: Resolved[]; unknownSkus: string[]; skipped: CostCorrectionReport["skipped"] }> {
  // Tenant gate: a foreign warehouse resolves to nothing, never to everything.
  await prisma.warehouse.findFirstOrThrow({
    where: { id: input.warehouseId, companyId: ctx.companyId },
  });

  const products = await prisma.product.findMany({
    where: { companyId: ctx.companyId, sku: { in: input.costs.map((c) => c.sku) } },
    select: { id: true, sku: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p]));

  const balances = await prisma.inventoryBalance.findMany({
    where: {
      companyId: ctx.companyId,
      warehouseId: input.warehouseId,
      productId: { in: products.map((p) => p.id) },
      variantId: null,
    },
    select: { id: true, productId: true, availableQty: true, avgCost: true },
  });
  const balanceByProduct = new Map(balances.map((b) => [b.productId, b]));

  const resolved: Resolved[] = [];
  const unknownSkus: string[] = [];
  const skipped: CostCorrectionReport["skipped"] = [];

  for (const cost of input.costs) {
    const product = bySku.get(cost.sku);
    if (!product) {
      // Named, never swallowed: a typo in a cost list must not read as
      // "nothing needed correcting".
      unknownSkus.push(cost.sku);
      continue;
    }
    const balance = balanceByProduct.get(product.id) ?? null;

    // The guard. A product already carrying a cost is left alone, so a second
    // run computes nothing — the same shape the opening import uses. It does
    // NOT cover a product with no stock, whose average stays 0 forever; there
    // the protection is the `unitCostSnapshot: 0` filter on the order side.
    if (balance && balance.avgCost !== 0) {
      skipped.push({ sku: cost.sku, reason: "ALREADY_COSTED" });
      continue;
    }

    resolved.push({
      productId: product.id,
      sku: cost.sku,
      unitCost: cost.unitCost,
      availableQty: balance?.availableQty ?? 0,
      balanceId: balance?.id ?? null,
    });
  }

  return { resolved, unknownSkus, skipped };
}

/** The orders a restatement would touch: confirmed, and still costed at zero. */
async function ordersToRestate(ctx: ServiceContext, productId: string, unitCost: number) {
  const items = await prisma.salesOrderItem.findMany({
    where: {
      productId,
      unitCostSnapshot: 0,
      salesOrder: { companyId: ctx.companyId, status: "CONFIRMED" },
    },
    select: {
      id: true, quantity: true, lineTotal: true, salesOrderId: true,
      salesOrder: { select: { salesOrderNumber: true } },
    },
    orderBy: { id: "asc" },
  });

  return items.map((item) => ({
    itemId: item.id,
    salesOrderId: item.salesOrderId,
    salesOrderNumber: item.salesOrder.salesOrderNumber,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
    addedCost: costOf(item.quantity, unitCost),
  }));
}

async function build(
  ctx: ServiceContext,
  input: { warehouseId: string; costs: CostInput[] },
): Promise<{ report: CostCorrectionReport; resolved: Resolved[] }> {
  const { resolved, unknownSkus, skipped } = await resolve(ctx, input);

  const lines: CostCorrectionLine[] = [];
  let totalCostAdded = 0;
  for (const item of resolved) {
    const orders = await ordersToRestate(ctx, item.productId, item.unitCost);
    totalCostAdded += orders.reduce((sum, o) => sum + o.addedCost, 0);
    lines.push({
      productId: item.productId,
      sku: item.sku,
      unitCost: item.unitCost,
      revaluedQty: item.availableQty,
      restatedOrders: orders.map((o) => ({
        salesOrderId: o.salesOrderId,
        salesOrderNumber: o.salesOrderNumber,
        quantity: o.quantity,
        addedCost: o.addedCost,
      })),
    });
  }

  return { report: { lines, unknownSkus, skipped, totalCostAdded }, resolved };
}

/**
 * Works out the correction without writing anything, so it can be printed and
 * read before it is believed.
 */
export async function planCostCorrection(
  ctx: ServiceContext,
  input: { warehouseId: string; costs: CostInput[] },
): Promise<CostCorrectionReport> {
  return (await build(ctx, input)).report;
}

export async function applyCostCorrection(
  ctx: ServiceContext,
  input: { warehouseId: string; costs: CostInput[] },
): Promise<CostCorrectionReport> {
  const { report, resolved } = await build(ctx, input);

  for (const item of resolved) {
    // The product's own opening date, so the history reads as though the cost
    // was always right. Falls back to now for a product with no opening
    // movement at all, rather than inventing a date from nothing.
    const opening = await prisma.inventoryMovement.findFirst({
      where: {
        companyId: ctx.companyId,
        warehouseId: input.warehouseId,
        productId: item.productId,
        referenceType: "FASTHUB_IMPORT",
      },
      orderBy: { movementDate: "asc" },
      select: { movementDate: true },
    });
    const movementDate = opening?.movementDate ?? new Date();

    // One transaction per product, as the opening correction does: one bad row
    // must not discard a whole catalogue's correction.
    await prisma.$transaction(async (tx) => {
      // Skipped entirely when nothing is on the shelf. A zero-quantity pair
      // would write two rows that move nothing and leave the average at 0,
      // because averaging an empty receipt into an empty balance is undefined.
      if (item.availableQty > 0) {
        const referenceNumber = await nextNumber(tx, ctx.companyId, "REV");
        const common = {
          warehouseId: input.warehouseId,
          productId: item.productId,
          variantId: null,
          bucket: "AVAILABLE" as const,
          quantity: item.availableQty,
          referenceType: REVALUATION,
          referenceId: item.productId,
          referenceNumber,
          movementDate,
        };
        await applyMovement(tx, ctx, {
          ...common,
          movementType: "ADJUSTMENT_OUT",
          direction: "OUT",
          reason: "Cost correction: withdrawing stock held at zero cost",
        });
        await applyMovement(tx, ctx, {
          ...common,
          movementType: "ADJUSTMENT_IN",
          direction: "IN",
          unitCost: item.unitCost,
          reason: "Cost correction: returning the same stock at its true cost",
        });
      }

      await writeAudit(tx, ctx, {
        action: "PRODUCT_COST_CORRECTION",
        entityType: "Product",
        entityId: item.productId,
        newValues: {
          sku: item.sku,
          unitCost: item.unitCost,
          revaluedQty: item.availableQty,
          movementDate: movementDate.toISOString(),
        },
      });
    });

    // The orders, read again inside the apply rather than trusted from the
    // plan: the plan may have been computed before another order confirmed.
    const orders = await ordersToRestate(ctx, item.productId, item.unitCost);
    const touched = new Set<string>();
    for (const order of orders) {
      await prisma.salesOrderItem.update({
        where: { id: order.itemId },
        data: {
          unitCostSnapshot: item.unitCost,
          // Recomputed from quantity × cost, never incremented. With the
          // `unitCostSnapshot: 0` filter above this is belt and braces — each
          // alone makes a re-run harmless, as a mutation test proves by
          // needing BOTH removed before the cost doubles.
          totalCost: order.addedCost,
          grossProfit: order.lineTotal - order.addedCost,
        },
      });
      touched.add(order.salesOrderId);
    }

    for (const salesOrderId of touched) {
      // The rollup is summed from the lines rather than incremented, so an
      // order holding one corrected line and one already-costed line lands on
      // the truth instead of on a delta applied to a stale total.
      const items = await prisma.salesOrderItem.findMany({
        where: { salesOrderId },
        select: { totalCost: true, grossProfit: true },
      });
      await prisma.salesOrder.update({
        where: { id: salesOrderId },
        data: {
          totalCost: items.reduce((sum, i) => sum + i.totalCost, 0),
          grossProfit: items.reduce((sum, i) => sum + i.grossProfit, 0),
        },
      });
      // Net profit follows gross only if the allocation is re-run; leaving it
      // would restate the cost and report the old margin.
      await recomputeOrderCostAllocation(ctx, salesOrderId);
    }
  }

  return report;
}

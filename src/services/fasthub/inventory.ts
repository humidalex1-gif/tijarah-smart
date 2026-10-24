import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { applyMovement } from "@/services/inventory";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";

/**
 * The ONE-TIME opening import: Fast Hub's counts become the books' starting
 * balances, because the books started empty and the goods physically sit in
 * Fast Hub's warehouse.
 *
 * This is deliberately not a mirror. Ongoing inventory syncs must feed
 * RECONCILIATION — assertions compared against the books — because copying the
 * warehouse's numbers into the books forever would erase the discrepancy this
 * project exists to expose. Hence the guard: a product that already carries
 * any balance at the warehouse is skipped, never overwritten, which also makes
 * a re-run harmless.
 *
 * Everything enters at ZERO cost. The purchase prices are unknown and are not
 * invented; inventory value stays 0 until the owner supplies costs or the
 * Salla sync brings `cost_price`.
 */

export type OpeningCount = {
  /** Fast Hub seller SKU code, matched exactly against `Product.sku`. */
  sku: string;
  /** Sellable units, in thousandths. Fast Hub's pass/available figure. */
  available: number;
  /** Failed-QC units, in thousandths. Fast Hub's fail figure. */
  damaged: number;
  /**
   * Landed cost per unit at COST_SCALE, from the owner's costing sheet —
   * purchase price plus shipping plus per-kg overhead, NEVER advertising
   * (rule 7: advertising is a period cost and must not reach avgCost).
   * Omitted means unknown, and the stock enters at 0 rather than a guess.
   */
  unitCost?: number;
};

export type OpeningImportReport = {
  imported: number;
  /** SKUs skipped because the product already holds a balance here. */
  skippedExisting: string[];
  /** SKUs skipped because they are bundles, which own no shelf. */
  skippedBundles: string[];
  /** SKUs with no matching product. */
  unknown: string[];
};

export async function importFastHubOpeningStock(
  ctx: ServiceContext,
  input: { warehouseId: string; counts: OpeningCount[] },
): Promise<OpeningImportReport> {
  // Tenant gate: a foreign warehouse resolves to nothing, never to everything.
  await prisma.warehouse.findFirstOrThrow({
    where: { id: input.warehouseId, companyId: ctx.companyId },
  });

  const report: OpeningImportReport = {
    imported: 0, skippedExisting: [], skippedBundles: [], unknown: [],
  };

  const products = await prisma.product.findMany({
    where: { companyId: ctx.companyId, sku: { in: input.counts.map((c) => c.sku) } },
    select: { id: true, sku: true, isBundle: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p]));

  for (const count of input.counts) {
    const product = bySku.get(count.sku);
    if (!product) {
      report.unknown.push(count.sku);
      continue;
    }
    if (product.isBundle) {
      report.skippedBundles.push(count.sku);
      continue;
    }
    if (count.available <= 0 && count.damaged <= 0) continue;

    const existing = await prisma.inventoryBalance.findFirst({
      where: { companyId: ctx.companyId, warehouseId: input.warehouseId, productId: product.id },
    });
    if (existing && (existing.availableQty !== 0 || existing.damagedQty !== 0
      || existing.disputedQty !== 0 || existing.reservedQty !== 0)) {
      report.skippedExisting.push(count.sku);
      continue;
    }

    // One transaction per product, mirroring postReconcile: a whole-catalogue
    // run in a single interactive transaction risks Prisma's timeout, and one
    // bad row must not discard the rest.
    await prisma.$transaction(async (tx) => {
      const referenceNumber = await nextNumber(tx, ctx.companyId, "FHI");
      const common = {
        warehouseId: input.warehouseId,
        productId: product.id,
        variantId: null,
        referenceType: "FASTHUB_IMPORT",
        referenceId: product.id,
        referenceNumber,
        reason: "Fast Hub opening stock import",
      } as const;

      const unitCost = count.unitCost ?? 0;
      if (count.available > 0) {
        await applyMovement(tx, ctx, {
          ...common,
          movementType: "ADJUSTMENT_IN", direction: "IN", bucket: "AVAILABLE",
          quantity: count.available, unitCost,
        });
      }
      if (count.damaged > 0) {
        // Straight into DAMAGED: these units were never sellable in our books,
        // and DAMAGED carries no cost basis (docs/decisions.md #7) — the cost
        // on the movement records what the loss was worth, nothing more.
        await applyMovement(tx, ctx, {
          ...common,
          movementType: "DAMAGED", direction: "IN", bucket: "DAMAGED",
          quantity: count.damaged, unitCost,
        });
      }

      await writeAudit(tx, ctx, {
        action: "FASTHUB_OPENING_IMPORT",
        entityType: "Product",
        entityId: product.id,
        newValues: { sku: count.sku, available: count.available, damaged: count.damaged },
      });
    });

    report.imported += 1;
  }

  return report;
}

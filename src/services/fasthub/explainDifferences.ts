import { prisma } from "@/lib/db";
import { toQty } from "@/lib/money";
import { previewReconcile } from "@/services/reconcile";
import type { ServiceContext } from "@/services/context";

/**
 * Why the warehouse and the books disagree, per SKU, for the sync banner.
 *
 * The banner said "warehouse 90 / books 91" and stopped, and the owner was
 * left to work out whether that unit was a return still in the post, a
 * damage the warehouse had not yet split out, or stock genuinely gone. The
 * reconcile service already reads that gap — which units an open claim
 * accounts for, which are shelf units missing with no claim behind them,
 * which are surplus the books have not received — so this asks it, and
 * only it. No second arithmetic: a preview is a read, and it writes nothing.
 *
 * The recorded differences carry whole units (display copy); the preview
 * speaks thousandths, so the conversion happens here, both ways.
 */

export type DifferenceExplanation = {
  /** Units an open claim accounts for — posting would close those claims. */
  settleable: number;
  /** Disputed units the warehouse's figure still does not account for. */
  stillClaimed: number;
  /** Shelf units missing with no claim behind them. Real shrinkage. */
  unexplained: number;
  /** Units the warehouse holds beyond what the books expect. */
  surplus: number;
  /** False when the warehouse must split sellable from damaged first. */
  determinate: boolean;
};

const UNIT = 1000;

export async function explainDifferences(
  ctx: ServiceContext,
  differences: { sku: string; fastHub: number; books: number }[],
): Promise<Record<string, DifferenceExplanation>> {
  if (differences.length === 0) return {};

  // The default warehouse IS the Fast Hub hub — the same choice the manual
  // poll makes, so the reading matches the run it explains.
  const warehouse = await prisma.warehouse.findFirst({
    where: { companyId: ctx.companyId, isDefault: true },
    select: { id: true },
  });
  if (!warehouse) return {};

  // A SKU the books do not know gets no reading: the sync lists unknown SKUs
  // separately, and a number about a product that does not exist is worse
  // than a dash.
  const products = await prisma.product.findMany({
    where: { companyId: ctx.companyId, sku: { in: differences.map((d) => d.sku) } },
    select: { id: true, sku: true },
  });
  const idBySku = new Map(products.map((p) => [p.sku, p.id]));
  const skuById = new Map(products.map((p) => [p.id, p.sku]));

  const lines = differences
    .filter((d) => idBySku.has(d.sku))
    .map((d) => ({ productId: idBySku.get(d.sku)!, sellable: toQty(d.fastHub) }));
  if (lines.length === 0) return {};

  const preview = await previewReconcile(ctx, { warehouseId: warehouse.id, asOf: new Date(), lines });

  return Object.fromEntries(preview.map((line) => [
    skuById.get(line.productId)!,
    {
      settleable: (line.settleableSellable + line.settleableDamaged) / UNIT,
      stillClaimed: line.stillClaimed / UNIT,
      unexplained: line.unexplained / UNIT,
      surplus: line.surplus / UNIT,
      determinate: line.determinate,
    },
  ]));
}

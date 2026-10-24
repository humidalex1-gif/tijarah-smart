import { prisma } from "@/lib/db";
import { LIVE_ORDER_STATUSES } from "@/services/reporting";
import type { OurProduct } from "./costCompare";

/**
 * The books' side of the Salla cost comparison.
 *
 * Two things here are easy to get subtly wrong and both change the answer:
 *
 * - `avgCost` is on `InventoryBalance`, per warehouse, not on `Product`. A
 *   product that has never held stock has NO balance row, and dropping those
 *   would hide precisely the zero-cost products this exists to find.
 * - "Sold" separates a cost gap that distorts BOOKED PROFIT from one that only
 *   understates inventory value. Only the former is urgent, and conflating them
 *   would offer to revalue stock nobody has sold.
 *
 * Bundles are excluded: they are assembled at pick time, hold no shelf of their
 * own, and their cost is the sum of their components (see `expandSaleLines`).
 */
export async function loadOurCosts(companyId: string): Promise<OurProduct[]> {
  const products = await prisma.product.findMany({
    where: { companyId, isBundle: false },
    select: { id: true, sku: true, nameAr: true, nameEn: true },
    orderBy: { sku: "asc" },
  });
  if (products.length === 0) return [];

  const ids = products.map((p) => p.id);

  const [balances, soldItems] = await Promise.all([
    prisma.inventoryBalance.findMany({
      where: { companyId, productId: { in: ids } },
      select: { productId: true, avgCost: true },
    }),
    // A DRAFT order moves no stock and books no profit, so it does not make a
    // zero cost urgent. Same status set the dashboard and the profit report
    // use, so "sold" cannot mean one thing here and another there.
    prisma.salesOrderItem.findMany({
      where: { productId: { in: ids }, salesOrder: { companyId, status: { in: LIVE_ORDER_STATUSES } } },
      select: { productId: true },
      distinct: ["productId"],
    }),
  ]);

  // One real warehouse today, but the query is not scoped to one. Taking the
  // highest non-zero average is deliberate: if any warehouse knows a cost, the
  // product is not the zero-cost case, and reporting it as zero would invite a
  // revaluation that overwrites a real weighted average.
  const costBySku = new Map<string, number>();
  for (const b of balances) {
    costBySku.set(b.productId, Math.max(costBySku.get(b.productId) ?? 0, b.avgCost));
  }
  const sold = new Set(soldItems.map((i) => i.productId));

  return products.map((p) => ({
    sku: p.sku,
    nameAr: p.nameAr,
    nameEn: p.nameEn,
    avgCost: costBySku.get(p.id) ?? 0,
    sold: sold.has(p.id),
  }));
}

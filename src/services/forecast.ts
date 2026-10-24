import { prisma } from "@/lib/db";

/**
 * When each product runs out, from how fast it actually sells.
 *
 * `lowStockProducts` compares a balance to a reorder level the owner typed
 * once per product. This compares it to the units that left the shelf for
 * sales over the last window, which turns "rainy-light is low" into
 * "rainy-light runs out in twelve days, order eighty". Read-only: nothing
 * here writes, and nothing here is a purchase order — it is the number the
 * owner puts on one.
 *
 * Demand is read from stock MOVEMENTS, not order lines, for one reason: a
 * bundle is one order line but several units of several components leaving
 * the shelf, and it is the components that run out. The cancellation
 * reversal comes back through the same table, so a cancelled sale nets to
 * zero rather than counting as demand.
 *
 * The window is cut on movementDate, which for a synced order is within an
 * hour of the order itself. Quantities are thousandths, as everywhere.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const UNIT = 1000;

export interface ForecastRow {
  productId: string;
  sku: string;
  nameAr: string;
  nameEn: string;
  /** Sellable units on hand across warehouses, thousandths. */
  availableQty: number;
  /** Units sold in the window net of cancellations, thousandths. */
  soldInWindow: number;
  /** Thousandths per day. */
  unitsPerDay: number;
  /** availableQty / unitsPerDay. */
  daysOfCover: number;
  /** Whole units, in thousandths, needed to reach `coverDays` of cover. Never negative. */
  suggestedQty: number;
}

export async function stockoutForecast(
  companyId: string,
  {
    now = new Date(),
    windowDays = 30,
    coverDays = 30,
  }: { now?: Date; windowDays?: number; coverDays?: number } = {},
): Promise<ForecastRow[]> {
  const since = new Date(now.getTime() - windowDays * DAY_MS);

  const [products, movements] = await Promise.all([
    prisma.product.findMany({
      where: { companyId, status: "ACTIVE", trackInventory: true },
      select: {
        id: true, sku: true, nameAr: true, nameEn: true,
        balances: { select: { availableQty: true } },
      },
    }),
    prisma.inventoryMovement.findMany({
      // No upper bound: a movement cannot be dated in the future, and a bound
      // at `now` would drop one written in the same second.
      where: {
        companyId,
        bucket: "AVAILABLE",
        movementDate: { gte: since },
        referenceType: { in: ["SALES_ORDER", "SALES_ORDER_CANCELLATION"] },
      },
      select: { productId: true, direction: true, quantity: true },
    }),
  ]);

  const sold = new Map<string, number>();
  for (const m of movements) {
    const signed = m.direction === "OUT" ? m.quantity : -m.quantity;
    sold.set(m.productId, (sold.get(m.productId) ?? 0) + signed);
  }

  const rows: ForecastRow[] = [];
  for (const p of products) {
    const soldInWindow = sold.get(p.id) ?? 0;
    // No velocity means no forecast, not an infinite one.
    if (soldInWindow <= 0) continue;

    const availableQty = p.balances.reduce((s, b) => s + b.availableQty, 0);
    const unitsPerDay = soldInWindow / windowDays;
    const daysOfCover = availableQty / unitsPerDay;
    // Rounded up to whole units: nobody orders 17.3 caddies.
    const needed = Math.ceil((unitsPerDay * coverDays) / UNIT) * UNIT;
    const suggestedQty = Math.max(0, needed - availableQty);

    rows.push({
      productId: p.id, sku: p.sku, nameAr: p.nameAr, nameEn: p.nameEn,
      availableQty, soldInWindow, unitsPerDay, daysOfCover, suggestedQty,
    });
  }

  // Soonest to run out first: that is the order the owner acts in.
  return rows.sort((a, b) => a.daysOfCover - b.daysOfCover);
}

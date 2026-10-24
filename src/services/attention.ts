import { prisma } from "@/lib/db";
import { lowStockProducts } from "@/services/reporting";
import { loadOurCosts } from "@/services/salla/ourCosts";

/**
 * What awaits the owner, counted in one read for the dashboard.
 *
 * The system already KNOWS these things — a sold product still costed at
 * zero, a claim the warehouse has not answered, an order stuck as a draft,
 * stock under its reorder level — but each lives on its own screen, so
 * knowing what is pending means remembering to visit four places.
 *
 * Strictly derived, never written. And each count reuses the definition its
 * own screen uses — "open claim" is claims.ts's `settledAt: null`, "sold" is
 * `loadOurCosts`'s live-order statuses, "low" is the reporting module's own
 * reorder comparison — because a card that counts differently from the screen
 * it links to teaches the owner to distrust both.
 */
export interface PendingReport {
  /** Sold at least once, still costed at zero: booked profit is inflated. */
  zeroCostSold: number;
  /** Claims the warehouse has not settled or rejected yet. */
  openClaims: number;
  /** Orders created and never confirmed — SO-0001's shape. CANCELLED is not
   *  pending: that is a decision on the record, not a question. */
  draftOrders: number;
  /** Products at or under their reorder level. */
  lowStock: number;
}

export async function pendingActions(companyId: string): Promise<PendingReport> {
  const [costs, openClaims, draftOrders, low] = await Promise.all([
    loadOurCosts(companyId),
    prisma.stockClaim.count({ where: { companyId, settledAt: null } }),
    prisma.salesOrder.count({ where: { companyId, status: "DRAFT" } }),
    lowStockProducts(companyId),
  ]);

  return {
    zeroCostSold: costs.filter((c) => c.sold && c.avgCost === 0).length,
    openClaims,
    draftOrders,
    lowStock: low.length,
  };
}

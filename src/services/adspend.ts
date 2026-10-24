import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { AdChannel } from "@/lib/constants";
import { invalidState } from "@/services/errors";
import { writeAudit } from "@/services/audit";

/**
 * Advertising spend.
 *
 * Two rules govern this whole module, and both are load-bearing.
 *
 * 1. Advertising is a PERIOD cost. It never enters `avgCost` or inventory
 *    value. Capitalising it would corrupt the cost basis, and `avgCost` has no
 *    rebuild path in this codebase — the damage would be permanent.
 *
 * 2. The per-product allocation is COMPUTED ON READ and never stored. Storing
 *    it means the first invoice that arrives late rewrites history: the same
 *    product then shows two different profits depending on which report was
 *    opened and when. The tests pin this by asserting the stored rows are
 *    exactly as entered after an allocation has been computed.
 */

export async function recordAdSpend(
  ctx: ServiceContext,
  input: {
    channel: AdChannel;
    periodStart: Date;
    periodEnd: Date;
    amount: number;
    productId?: string | null;
    campaign?: string | null;
    notes?: string | null;
  },
): Promise<{ adSpendId: string }> {
  if (input.periodEnd.getTime() < input.periodStart.getTime()) {
    throw invalidState("ADSPEND_INVALID_PERIOD", {
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
    });
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw invalidState("ADSPEND_INVALID_AMOUNT", { amount: input.amount });
  }

  return prisma.$transaction(async (tx) => {
    if (input.productId) {
      await tx.product.findFirstOrThrow({
        where: { id: input.productId, companyId: ctx.companyId },
      });
    }

    const row = await tx.adSpend.create({
      data: {
        companyId: ctx.companyId,
        channel: input.channel,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amount: input.amount,
        productId: input.productId ?? null,
        campaign: input.campaign ?? null,
        notes: input.notes ?? null,
      },
    });

    await writeAudit(tx, ctx, {
      action: "ADSPEND_RECORDED",
      entityType: "AdSpend",
      entityId: row.id,
      newValues: {
        channel: input.channel,
        amount: input.amount,
        productId: input.productId ?? null,
      },
    });

    return { adSpendId: row.id };
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The share of a campaign's spend that belongs to the reporting window,
 * pro-rated by overlapping days.
 *
 * A campaign rarely lines up with a calendar month. Counting the whole amount
 * whenever the periods touch would double the cost the moment the merchant
 * opened two adjacent reports; counting none of it — the original behaviour —
 * hid the cost from both. Pro-rating by day is the only split where the parts
 * add back up to the invoice.
 *
 * Both bounds are inclusive: a single-day campaign spans one day, not zero.
 * Rounding is floor, so a campaign split across windows can leave at most one
 * halala unattributed rather than conjuring one that was never spent.
 */
function overlappingAmount(
  amount: number,
  periodStart: Date,
  periodEnd: Date,
  from: Date,
  to: Date,
): number {
  const start = Math.max(periodStart.getTime(), from.getTime());
  const end = Math.min(periodEnd.getTime(), to.getTime());
  if (end < start) return 0;

  const spanDays = Math.floor((periodEnd.getTime() - periodStart.getTime()) / DAY_MS) + 1;
  const overlapDays = Math.floor((end - start) / DAY_MS) + 1;
  if (spanDays <= 0) return 0;
  if (overlapDays >= spanDays) return amount;

  return Math.floor((amount * overlapDays) / spanDays);
}

export async function adSpendForPeriod(
  ctx: ServiceContext,
  input: {
    from: Date;
    to: Date;
    /**
     * Revenue per product for the same window, used to allocate spend that was
     * not tagged to a product. Omit it and untagged spend simply stays
     * unallocated rather than being spread arbitrarily.
     */
    revenueByProduct?: Map<string, number>;
  },
): Promise<{ total: number; byProduct: Map<string, number>; unallocated: number }> {
  // OVERLAP, not containment. Requiring the spend period to sit inside the
  // window dropped every campaign that crossed a month boundary — from BOTH
  // months — which silently understated cost and overstated profit in each.
  const rows = await prisma.adSpend.findMany({
    where: {
      companyId: ctx.companyId,
      periodStart: { lte: input.to },
      periodEnd: { gte: input.from },
    },
  });

  const byProduct = new Map<string, number>();
  let total = 0;
  let untagged = 0;

  for (const row of rows) {
    const amount = overlappingAmount(row.amount, row.periodStart, row.periodEnd, input.from, input.to);
    if (amount === 0) continue;
    total += amount;
    if (row.productId) {
      byProduct.set(row.productId, (byProduct.get(row.productId) ?? 0) + amount);
    } else {
      untagged += amount;
    }
  }

  const revenue = input.revenueByProduct ?? new Map<string, number>();
  const revenueTotal = [...revenue.values()].reduce((sum, value) => sum + value, 0);

  // No revenue to allocate by means no defensible allocation. Reporting it as
  // unallocated is honest; spreading it evenly would invent a number.
  if (untagged === 0 || revenueTotal <= 0) {
    return { total, byProduct, unallocated: untagged };
  }

  // Largest-remainder allocation so the parts sum to the whole exactly. A
  // plain rounded pro-rata leaves halalas unassigned, and this figure feeds a
  // profit line the merchant will reconcile against their bank.
  const entries = [...revenue.entries()];
  const exact = entries.map(([productId, value]) => {
    const share = (untagged * value) / revenueTotal;
    const floor = Math.floor(share);
    return { productId, floor, remainder: share - floor };
  });

  let assigned = exact.reduce((sum, e) => sum + e.floor, 0);
  const order = [...exact].sort((a, b) => b.remainder - a.remainder);
  let index = 0;
  while (assigned < untagged && order.length > 0) {
    order[index % order.length].floor += 1;
    assigned += 1;
    index += 1;
  }

  for (const entry of exact) {
    if (entry.floor === 0) continue;
    byProduct.set(entry.productId, (byProduct.get(entry.productId) ?? 0) + entry.floor);
  }

  return { total, byProduct, unallocated: 0 };
}

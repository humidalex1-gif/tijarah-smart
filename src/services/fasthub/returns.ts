import { prisma } from "@/lib/db";
import { toQty } from "@/lib/money";
import { openClaim, settleClaim, cancelClaim } from "@/services/claims";
import { paginateReturnOrders, fetchReturnOrderById, type OmnifulReturnOrder } from "@/services/fasthub/api";

/**
 * The returns poller — the reason this project exists.
 *
 * "Goods that fail to reach the customer come back and the warehouse does not
 * count them. So the books and the shelf disagree and the loss is invisible."
 * This closes that loop: Fast Hub says goods are coming back, a claim opens;
 * Fast Hub's quality check decides sellable vs damaged, the claim settles into
 * the right bucket.
 *
 * The QC split is the load-bearing moment, and it is the one thing the public
 * docs never showed for a PROCESSED return (spec §8.2). So the split is read
 * defensively: when the payload does not carry per-unit numbers, the claim
 * stays open and the return is NAMED in the report. Assuming "all sellable"
 * would silently book damaged goods as stock and hide exactly the loss the
 * merchant is trying to see.
 */

/** Statuses meaning goods are on their way back but not yet counted. */
const OPENING_STATUSES = [
  "new return request", "return request approved", "return initiated",
  "return shipment created", "return order arrived at hub", "return to origin",
];

/** The moment sellable and damaged are decided. */
const QC_STATUSES = ["return order qc processed", "return order completed"];

/** The return is not happening: withdraw the claim. */
const CANCELLING_STATUSES = [
  "return request rejected", "return order cancelled",
];

const normalise = (value: string | undefined) => (value ?? "").trim().toLowerCase();

export type ReturnSyncReport = {
  opened: number;
  settledSellable: number;
  settledDamaged: number;
  cancelled: number;
  /** Returns whose QC ran but carried no per-unit split; claims left open. */
  qcSplitMissing: string[];
  unknownSkus: string[];
};

type ReturnItemWithQc = {
  sku_code: string;
  return_quantity: number;
  qc_passed_quantity?: number;
  qc_failed_quantity?: number;
};

export async function syncFastHubReturns(
  companyId: string,
  warehouseId: string,
): Promise<ReturnSyncReport> {
  const connection = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId } });
  const report: ReturnSyncReport = {
    opened: 0, settledSellable: 0, settledDamaged: 0, cancelled: 0,
    qcSplitMissing: [], unknownSkus: [],
  };

  const cursor = await paginateReturnOrders(companyId, connection.returnsCursor, async (page) => {
    for (const summary of page) {
      await handleReturn(companyId, warehouseId, summary, report);
    }
  });

  // Advanced only now: a page that threw must be seen again, not skipped.
  await prisma.fastHubConnection.update({
    where: { companyId },
    data: { returnsCursor: cursor, lastPolledAt: new Date() },
  });

  return report;
}

async function handleReturn(
  companyId: string,
  warehouseId: string,
  summary: OmnifulReturnOrder,
  report: ReturnSyncReport,
): Promise<void> {
  const status = normalise(summary.status);
  const ctx = { companyId, userId: null };

  if (CANCELLING_STATUSES.includes(status)) {
    const claims = await prisma.stockClaim.findMany({
      where: { companyId, sourceKey: summary.return_order_id, settledAt: null },
      select: { id: true },
    });
    for (const claim of claims) {
      await cancelClaim(ctx, { claimId: claim.id, warehouseId, assertedBy: "WAREHOUSE" });
      report.cancelled += 1;
    }
    return;
  }

  const isQc = QC_STATUSES.includes(status);
  if (!isQc && !OPENING_STATUSES.includes(status)) return;

  // The V2 list carries no per-SKU lines, so the detail call is the only
  // source of what actually came back.
  const detail = await fetchReturnOrderById(companyId, summary.return_order_id);
  const items = (detail.items ?? []) as ReturnItemWithQc[];
  if (items.length === 0) {
    if (isQc) report.qcSplitMissing.push(summary.return_order_id);
    return;
  }

  const skus = [...new Set(items.map((i) => i.sku_code))];
  const products = await prisma.product.findMany({
    where: { companyId, sku: { in: skus } },
    select: { id: true, sku: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p.id]));
  const missing = skus.filter((sku) => !bySku.has(sku));
  if (missing.length > 0) {
    for (const sku of missing) {
      if (!report.unknownSkus.includes(sku)) report.unknownSkus.push(sku);
    }
    return;
  }

  for (const item of items) {
    const productId = bySku.get(item.sku_code)!;
    // Asked BEFORE opening so the report counts what actually changed. The
    // claim itself is idempotent on the return id, so a re-poll finds the
    // same row — but reporting "1 opened" on every poll of the same return
    // would make a quiet sync look like a busy one.
    const already = await prisma.stockClaim.findFirst({
      where: { companyId, sourceKey: summary.return_order_id, productId },
      select: { id: true },
    });
    // openClaim throws on a quantity change rather than silently dropping the
    // difference, which is what makes the re-poll safe.
    const { claimId } = await openClaim(ctx, {
      productId,
      kind: "RETURN",
      assertedBy: "WAREHOUSE",
      quantity: toQty(item.return_quantity),
      warehouseId,
      sourceKey: summary.return_order_id,
    });
    if (!isQc) {
      if (!already) report.opened += 1;
      continue;
    }

    const passed = item.qc_passed_quantity;
    const failed = item.qc_failed_quantity;
    if (passed === undefined && failed === undefined) {
      // QC ran but told us nothing per unit. Leave it open and say so.
      if (!report.qcSplitMissing.includes(summary.return_order_id)) {
        report.qcSplitMissing.push(summary.return_order_id);
      }
      continue;
    }

    // Capped at what is still OPEN, never the figure as sent. QC_STATUSES
    // holds both "qc processed" and "completed", so a settled return
    // re-enters the stream when its status advances — and a page re-read
    // after a mid-walk failure re-delivers it too. Settling unconditionally
    // threw CLAIM_SETTLE_EXCEEDS_OPEN on the second pass, aborted the walk
    // before the cursor stored, and wedged the returns feed permanently.
    // A re-poll of a settled return is a no-op, which is what "idempotent"
    // has to mean on the feed this project exists for.
    const claim = await prisma.stockClaim.findUniqueOrThrow({
      where: { id: claimId }, select: { quantity: true, settledQty: true },
    });
    let open = claim.quantity - claim.settledQty;

    if (passed && passed > 0 && open > 0) {
      const settle = Math.min(toQty(passed), open);
      await settleClaim(ctx, {
        claimId, quantity: settle, assertedBy: "WAREHOUSE",
        warehouseId, outcome: "SELLABLE",
      });
      report.settledSellable += settle;
      open -= settle;
    }
    if (failed && failed > 0 && open > 0) {
      const settle = Math.min(toQty(failed), open);
      await settleClaim(ctx, {
        claimId, quantity: settle, assertedBy: "WAREHOUSE",
        warehouseId, outcome: "DAMAGED",
      });
      report.settledDamaged += settle;
    }
  }
}

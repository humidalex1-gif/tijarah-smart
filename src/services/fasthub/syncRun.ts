import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { PollReport } from "@/services/fasthub/poll";

/**
 * Makes the sync visible.
 *
 * The hourly timer writes its report to the systemd journal, which nobody
 * opens. So an order that failed to import, a SKU the catalogue does not know,
 * or a warehouse figure that disagrees with the books all happen in silence —
 * and silence looks exactly like "nothing to report". This project has shipped
 * an inert feature that way once already.
 *
 * Every run is recorded, successful ones included. A screen that only ever
 * shows problems cannot distinguish "no problems" from "not running", which is
 * the failure this exists to prevent.
 */

export type SyncAttention = {
  /** SKUs an order named that match no product. The order was NOT imported. */
  unknownSkus: string[];
  /** Orders older than a product's opening balance, skipped by the guard. */
  preOpening: string[];
  /** Orders that threw and were left unimported, by Fast Hub number. */
  failedOrders: string[];
  /**
   * Drafts that can no longer be re-read, by order number. Each is an order
   * the books will never finish on their own: no stock moved, no profit
   * recorded, and no future poll will revisit it. Only a human can clear one.
   *
   * Drafts merely WAITING to ship are deliberately absent — that is the
   * ordinary state of a fresh order, and a banner that fires on it would
   * teach the owner to ignore the banner.
   */
  draftsUnreadable: string[];
  cancelledAfterConfirm: string[];
  /** Returns whose QC carried no sellable/damaged split; claims left open. */
  qcSplitMissing: string[];
  /** Resources that threw outright — the sync did not run for these. */
  failedResources: string[];
  /** Products where Fast Hub's count and the books disagree. */
  differences: { sku: string; fastHub: number; books: number }[];
};

export type SyncOutcome = "OK" | "ATTENTION" | "FAILED";

const EMPTY: SyncAttention = {
  unknownSkus: [], preOpening: [], failedOrders: [], draftsUnreadable: [], cancelledAfterConfirm: [],
  qcSplitMissing: [], failedResources: [], differences: [],
};

/**
 * Reduces a poll report to what a human has to do about it.
 *
 * FAILED outranks ATTENTION: when a resource threw, the counts from the ones
 * that did run are a partial picture, and reporting a partial picture as
 * merely "needs a look" understates it.
 */
export function summariseSync(report: PollReport): {
  outcome: SyncOutcome;
  attention: SyncAttention;
  ordersCreated: number;
  claimsOpened: number;
  diffCount: number;
} {
  const differences = (report.inventory?.lines ?? [])
    .filter((line) => line.difference !== 0)
    .map((line) => ({
      sku: line.sku,
      // Stored in units, not thousandths: this is display copy for a screen
      // and a message, not an input to any arithmetic.
      fastHub: line.sellable / 1000,
      books: line.booksAvailable / 1000,
    }));

  const attention: SyncAttention = {
    ...EMPTY,
    unknownSkus: [...new Set([
      ...(report.orders?.unknownSkus ?? []),
      ...(report.returns?.unknownSkus ?? []),
      ...(report.inventory?.unknownSkus ?? []),
    ])],
    preOpening: report.orders?.preOpening ?? [],
    failedOrders: report.orders?.failed ?? [],
    draftsUnreadable: report.orders?.draftsUnreadable ?? [],
    cancelledAfterConfirm: report.orders?.cancelledAfterConfirm ?? [],
    qcSplitMissing: report.returns?.qcSplitMissing ?? [],
    failedResources: report.failures.map((failure) => failure.resource),
    differences,
  };

  const needsAttention =
    attention.unknownSkus.length > 0 ||
    attention.preOpening.length > 0 ||
    attention.failedOrders.length > 0 ||
    attention.draftsUnreadable.length > 0 ||
    attention.cancelledAfterConfirm.length > 0 ||
    attention.qcSplitMissing.length > 0 ||
    attention.differences.length > 0;

  return {
    outcome: attention.failedResources.length > 0 ? "FAILED" : needsAttention ? "ATTENTION" : "OK",
    attention,
    ordersCreated: report.orders?.created ?? 0,
    claimsOpened: report.returns?.opened ?? 0,
    diffCount: differences.length,
  };
}

export async function recordSyncRun(
  companyId: string,
  report: PollReport,
  input: { trigger: "SCHEDULED" | "MANUAL"; startedAt: Date },
) {
  const summary = summariseSync(report);
  return prisma.syncRun.create({
    data: {
      companyId,
      source: "FASTHUB",
      trigger: input.trigger,
      startedAt: input.startedAt,
      finishedAt: report.polledAt,
      outcome: summary.outcome,
      ordersCreated: summary.ordersCreated,
      claimsOpened: summary.claimsOpened,
      diffCount: summary.diffCount,
      // Only when there is something to say. A JSON blob of six empty arrays
      // on every healthy run is noise in the row and in every query that
      // reads it.
      attention: summary.outcome === "OK" ? null : JSON.stringify(summary.attention),
    },
  });
}

export type SyncRunView = {
  id: string;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: SyncOutcome;
  ordersCreated: number;
  claimsOpened: number;
  diffCount: number;
  attention: SyncAttention;
  acknowledgedAt: Date | null;
};

function toView(row: {
  id: string; trigger: string; startedAt: Date; finishedAt: Date | null;
  outcome: string; ordersCreated: number; claimsOpened: number; diffCount: number;
  attention: string | null; acknowledgedAt: Date | null;
}): SyncRunView {
  let attention = EMPTY;
  if (row.attention) {
    try {
      attention = { ...EMPTY, ...(JSON.parse(row.attention) as Partial<SyncAttention>) };
    } catch {
      // A row written by an older shape must not break the screen that shows
      // it. The counts on the row itself still tell the truth.
    }
  }
  return { ...row, outcome: row.outcome as SyncOutcome, attention };
}

/** The most recent runs, newest first, for the sync history panel. */
export async function recentSyncRuns(companyId: string, take = 10): Promise<SyncRunView[]> {
  const rows = await prisma.syncRun.findMany({
    where: { companyId },
    orderBy: { startedAt: "desc" },
    take,
  });
  return rows.map(toView);
}

/**
 * Runs that need the owner and have not been acknowledged. Drives the banner:
 * an empty array means the sync is genuinely quiet, which is only meaningful
 * alongside `recentSyncRuns` proving it ran at all.
 */
export async function openSyncAttention(companyId: string): Promise<SyncRunView[]> {
  const rows = await prisma.syncRun.findMany({
    where: {
      companyId,
      outcome: { in: ["ATTENTION", "FAILED"] },
      acknowledgedAt: null,
    },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return rows.map(toView);
}

/**
 * The owner saying "I have seen these". The rows stay — this is a read
 * marker, not a delete, so the history of what the sync found survives being
 * dismissed.
 */
export async function acknowledgeSyncRuns(ctx: ServiceContext): Promise<number> {
  const result = await prisma.syncRun.updateMany({
    where: { companyId: ctx.companyId, acknowledgedAt: null, outcome: { in: ["ATTENTION", "FAILED"] } },
    data: { acknowledgedAt: new Date() },
  });
  return result.count;
}

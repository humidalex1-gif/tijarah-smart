import { describe, it, expect, beforeEach } from "vitest";
import { toQty } from "@/lib/money";
import type { PollReport } from "@/services/fasthub/poll";
import {
  summariseSync, recordSyncRun, recentSyncRuns, openSyncAttention, acknowledgeSyncRuns,
} from "@/services/fasthub/syncRun";
import { makeCompany, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The sync runs unattended every hour and reports into the systemd journal,
 * where no merchant will ever look. Everything here exists so that what it
 * found reaches a screen instead.
 */

const QUIET: PollReport = {
  orders: {
    created: 2, alreadySeen: 5, skipped: 0, unknownSkus: [], preOpening: [], failed: [],
    draftsConfirmed: 0, draftsPending: 0, draftsUnreadable: [], cancelledAfterConfirm: [],
  },
  returns: { opened: 0, settledSellable: 0, settledDamaged: 0, cancelled: 0, qcSplitMissing: [], unknownSkus: [] },
  inventory: { lines: [{ productId: "p1", sku: "caddy-long-012", sellable: toQty(2), onHand: toQty(3), booksAvailable: toQty(2), difference: 0 }], unknownSkus: [] },
  failures: [],
  polledAt: new Date("2026-08-05T10:00:00.000Z"),
};

const startedAt = new Date("2026-08-05T09:59:00.000Z");

describe("summariseSync", () => {
  it("calls a run with nothing to act on OK", () => {
    expect(summariseSync(QUIET).outcome).toBe("OK");
  });

  it("raises ATTENTION and names an order skipped for predating the opening balance", () => {
    const summary = summariseSync({
      ...QUIET,
      orders: { ...QUIET.orders!, preOpening: ["1614465370"], unknownSkus: ["rainy-bundle-001"] },
    });

    expect(summary.outcome).toBe("ATTENTION");
    expect(summary.attention.preOpening).toEqual(["1614465370"]);
    expect(summary.attention.unknownSkus).toEqual(["rainy-bundle-001"]);
  });

  /**
   * A draft that cannot be re-read is an order the books will never finish on
   * their own: no stock moved, no profit recorded, and nothing in the system
   * will ever revisit it. Production carried SO-0001 that way — 518.00 SAR —
   * for days, precisely because nothing put it on a screen.
   */
  it("raises ATTENTION and names a draft it can no longer re-read", () => {
    const summary = summariseSync({
      ...QUIET,
      orders: { ...QUIET.orders!, draftsUnreadable: ["SO-0001"] },
    });

    expect(summary.outcome).toBe("ATTENTION");
    expect(summary.attention.draftsUnreadable).toEqual(["SO-0001"]);
  });

  it("stays OK when a draft is merely waiting to ship", () => {
    // The ordinary case, and it must not cry wolf: an order placed an hour ago
    // has not shipped yet, and there is nothing for anyone to do about it.
    const summary = summariseSync({
      ...QUIET,
      orders: { ...QUIET.orders!, draftsPending: 3, draftsConfirmed: 1 },
    });

    expect(summary.outcome).toBe("OK");
  });

  it("raises ATTENTION when the warehouse and the books disagree, in units", () => {
    // The difference IS the product. A sync that finds one and says nothing
    // has hidden the only number the merchant is here for.
    const summary = summariseSync({
      ...QUIET,
      inventory: {
        lines: [{
          productId: "p1", sku: "flodable-dish-020",
          sellable: toQty(11), onHand: toQty(12), booksAvailable: toQty(18), difference: toQty(-7),
        }],
        unknownSkus: [],
      },
    });

    expect(summary.outcome).toBe("ATTENTION");
    expect(summary.diffCount).toBe(1);
    expect(summary.attention.differences).toEqual([
      { sku: "flodable-dish-020", fastHub: 11, books: 18 },
    ]);
  });

  it("calls a run FAILED when a resource threw, even alongside other findings", () => {
    // A partial picture reported as "needs a look" understates it: the counts
    // that did come back describe only the resources that ran.
    const summary = summariseSync({
      ...QUIET,
      orders: { ...QUIET.orders!, preOpening: ["1614465370"] },
      failures: [{ resource: "returns", message: "HTTP 500" }],
    });

    expect(summary.outcome).toBe("FAILED");
    expect(summary.attention.failedResources).toEqual(["returns"]);
    expect(summary.attention.preOpening).toEqual(["1614465370"]);
  });
});

describe("sync run history", () => {
  beforeEach(resetDb);

  it("records a quiet run too, so silence can be told apart from not running", async () => {
    const company = await makeCompany();

    await recordSyncRun(company.id, QUIET, { trigger: "SCHEDULED", startedAt });

    const runs = await recentSyncRuns(company.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("OK");
    expect(runs[0].trigger).toBe("SCHEDULED");
    expect(runs[0].ordersCreated).toBe(2);
    expect(await openSyncAttention(company.id)).toEqual([]);
  });

  it("surfaces a run that needs the owner, with its details intact", async () => {
    const company = await makeCompany();

    await recordSyncRun(company.id, {
      ...QUIET,
      orders: { ...QUIET.orders!, failed: ["1055521778"] },
    }, { trigger: "MANUAL", startedAt });

    const open = await openSyncAttention(company.id);
    expect(open).toHaveLength(1);
    expect(open[0].outcome).toBe("ATTENTION");
    expect(open[0].attention.failedOrders).toEqual(["1055521778"]);
  });

  it("keeps the run after it is acknowledged, and only clears the banner", async () => {
    const company = await makeCompany();
    await recordSyncRun(company.id, {
      ...QUIET,
      orders: { ...QUIET.orders!, failed: ["1055521778"] },
    }, { trigger: "SCHEDULED", startedAt });

    const cleared = await acknowledgeSyncRuns(makeCtx(company.id));

    expect(cleared).toBe(1);
    expect(await openSyncAttention(company.id)).toEqual([]);
    // The history is the point: dismissing a warning must not erase what the
    // sync found.
    const runs = await recentSyncRuns(company.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].attention.failedOrders).toEqual(["1055521778"]);
  });

  it("does not leak another company's runs", async () => {
    const mine = await makeCompany("Mine");
    const theirs = await makeCompany("Theirs");
    await recordSyncRun(theirs.id, {
      ...QUIET, orders: { ...QUIET.orders!, failed: ["x"] },
    }, { trigger: "SCHEDULED", startedAt });

    expect(await recentSyncRuns(mine.id)).toEqual([]);
    expect(await openSyncAttention(mine.id)).toEqual([]);
    expect(await acknowledgeSyncRuns(makeCtx(mine.id))).toBe(0);
  });
});

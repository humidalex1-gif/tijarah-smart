/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { PollReport } from "@/services/fasthub/poll";
import { SyncPanel } from "./SyncPanel";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const report: PollReport = {
  orders: {
    created: 0, alreadySeen: 0, skipped: 0,
    unknownSkus: [], preOpening: ["1051735844"], failed: [],
    draftsConfirmed: 0, draftsPending: 0, draftsUnreadable: [], cancelledAfterConfirm: [],
  },
  returns: null,
  inventory: null,
  failures: [],
  polledAt: new Date("2026-08-05T00:00:00Z"),
};

const syncFastHubAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ syncFastHubAction }));

const labels = {
  syncNow: "Sync now", syncing: "Syncing", syncDone: "Done",
  syncOrdersCreated: "Orders created", syncClaimsOpened: "Claims opened",
  syncSettledSellable: "Sellable", syncSettledDamaged: "Damaged",
  syncUnknownSkus: "Unknown SKUs", syncQcMissing: "QC missing",
  syncFailures: "Failures", syncDiffs: "Differences", syncNoChanges: "Nothing changed",
  syncOrdersFailed: "Orders failed",
  syncPreOpening: "Orders older than the opening balance",
  generic: "Something went wrong",
};

describe("SyncPanel", () => {
  it("names the orders skipped for predating the opening balance", async () => {
    // A skip the merchant cannot see is a skip that never happened, as far as
    // they are concerned — this project has already shipped one feature that
    // was inert for eight tasks because nothing on screen revealed it.
    syncFastHubAction.mockResolvedValueOnce({ ok: true, data: report });
    render(<SyncPanel labels={labels} disabled={false} errors={{}} />);

    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() => expect(screen.getByText("Done")).toBeDefined());
    expect(screen.getByText(/Orders older than the opening balance/)).toBeDefined();
    expect(screen.getByText("1051735844")).toBeDefined();
    // It is a thing to act on, so the panel must not also call the sync quiet.
    expect(screen.queryByText("Nothing changed")).toBeNull();
  });
});

/**
 * `action()` returns a message KEY, never a sentence. This panel rendered it
 * raw, so an expired token put "errors.FASTHUB_TOKEN_EXPIRED" on the settings
 * screen — the one place the owner goes to find out what is wrong. The
 * dashboard's SyncNowButton got this right from its first commit; this is
 * the same contract applied to its older sibling.
 */
describe("SyncPanel failure wording", () => {
  it("says what went wrong in words, not as a message key", async () => {
    vi.mocked(syncFastHubAction).mockResolvedValueOnce({
      ok: false, error: "errors.FASTHUB_TOKEN_EXPIRED",
    } as never);
    render(
      <SyncPanel
        labels={labels}
        disabled={false}
        errors={{ "errors.FASTHUB_TOKEN_EXPIRED": "The Fast Hub access token has expired." }}
      />,
    );

    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() =>
      expect(screen.getByText("The Fast Hub access token has expired.")).toBeDefined());
    expect(screen.queryByText(/errors\./)).toBeNull();
  });

  it("falls back to the generic message for a key it has no wording for", async () => {
    vi.mocked(syncFastHubAction).mockResolvedValueOnce({
      ok: false, error: "errors.SOMETHING_NEW",
    } as never);
    render(<SyncPanel labels={labels} disabled={false} errors={{}} />);

    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeDefined());
  });
});

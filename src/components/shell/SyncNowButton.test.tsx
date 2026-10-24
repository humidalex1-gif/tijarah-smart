/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SyncNowButton } from "./SyncNowButton";

afterEach(cleanup);
// Braces, not a concise arrow: an arrow returning a mock hands Vitest that mock
// as the hook cleanup function, which it then calls with zero arguments.
beforeEach(() => { vi.clearAllMocks(); });

// Declared through `vi.hoisted` because `vi.mock` is hoisted above every
// `const` in this file, and a factory closing over a plain one reads it in its
// temporal dead zone.
const { refresh, syncFastHubAction } = vi.hoisted(() => ({
  refresh: vi.fn(),
  syncFastHubAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
}));

vi.mock("@/app/[locale]/(app)/settings/fasthub/actions", () => ({ syncFastHubAction }));

const labels = {
  syncNow: "Sync now",
  syncing: "Syncing…",
  done: "Sync complete.",
  generic: "Something went wrong.",
  errors: { "errors.FASTHUB_TOKEN_EXPIRED": "The Fast Hub access token has expired." },
};

describe("SyncNowButton", () => {
  it("re-reads the page after the poll, so the banner shows the run it just made", async () => {
    // Without the refresh the owner presses the button, the poll writes a new
    // run, and the screen keeps showing the stale one — indistinguishable from
    // a button that does nothing.
    syncFastHubAction.mockResolvedValueOnce({ ok: true, data: null });
    render(<SyncNowButton labels={labels} />);

    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() => expect(screen.getByText("Sync complete.")).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });

  it("says what went wrong in words, not as a message key", async () => {
    // `action()` returns a translation KEY, not a sentence. Rendering it raw
    // puts "errors.FASTHUB_TOKEN_EXPIRED" on the owner's dashboard.
    syncFastHubAction.mockResolvedValueOnce({ ok: false, error: "errors.FASTHUB_TOKEN_EXPIRED" });
    render(<SyncNowButton labels={labels} />);

    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() =>
      expect(screen.getByText("The Fast Hub access token has expired.")).toBeTruthy());
    expect(screen.queryByText(/errors\./)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to the generic message for a key it has no wording for", async () => {
    syncFastHubAction.mockResolvedValueOnce({ ok: false, error: "errors.SOMETHING_NEW" });
    render(<SyncNowButton labels={labels} />);

    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() => expect(screen.getByText("Something went wrong.")).toBeTruthy());
  });
});

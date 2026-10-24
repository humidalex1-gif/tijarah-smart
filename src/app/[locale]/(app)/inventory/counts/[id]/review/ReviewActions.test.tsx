/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ReviewActions, RecountButton } from "./ReviewActions";

// vitest.config.ts doesn't set `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) registration never fires — without this, each
// test's rendered tree stays in the DOM (same rationale as
// ResetPasswordButton.test.tsx / ConfirmDialog.test.tsx).
afterEach(cleanup);

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, back: vi.fn() }) }));

const postStockCountAction = vi.fn();
const cancelStockCountAction = vi.fn();
const requestRecountAction = vi.fn();
vi.mock("../../actions", () => ({
  postStockCountAction: (...args: unknown[]) => postStockCountAction(...args),
  cancelStockCountAction: (...args: unknown[]) => cancelStockCountAction(...args),
  requestRecountAction: (...args: unknown[]) => requestRecountAction(...args),
}));

const labels = {
  post: "Post count",
  postConfirmTitle: "Post this count?",
  postConfirmMessage: "Posting count CNT-0007 will move stock on 2 lines.",
  cancel: "Cancel count",
  cancelTitle: "Cancel this count?",
  cancelReason: "Reason for cancellation",
  cancelMessage: "This will cancel count CNT-0007.",
  confirm: "Confirm",
  dismiss: "Cancel",
  loading: "Loading...",
  errors: {
    "errors.generic": "Something went wrong",
    "errors.REASON_REQUIRED": "Please give a reason",
    "errors.COUNT_ALREADY_POSTED": "Already posted",
    "errors.COUNT_SHORTFALL_EXCEEDS_STOCK": "Shortfall exceeds stock",
  },
};

describe("ReviewActions — post", () => {
  beforeEach(() => {
    postStockCountAction.mockReset();
    cancelStockCountAction.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  it("posts the count and refreshes the page on success", async () => {
    postStockCountAction.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1", linesPosted: 2, linesSkipped: 1, movementsCreated: 2 } });
    render(<ReviewActions sessionId="s1" labels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Post count" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(postStockCountAction).toHaveBeenCalledTimes(1);
    const fd = postStockCountAction.mock.calls[0][0] as FormData;
    expect(fd.get("sessionId")).toBe("s1");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the real translated error and does not refresh when posting fails", async () => {
    postStockCountAction.mockResolvedValueOnce({ ok: false, error: "errors.COUNT_SHORTFALL_EXCEEDS_STOCK" });
    render(<ReviewActions sessionId="s1" labels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Post count" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText("Shortfall exceeds stock")).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fires exactly one postStockCountAction call when Confirm is clicked twice synchronously", () => {
    postStockCountAction.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<ReviewActions sessionId="s1" labels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Post count" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    confirmButton.click();
    confirmButton.click();

    expect(postStockCountAction).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewActions — cancel", () => {
  beforeEach(() => {
    postStockCountAction.mockReset();
    cancelStockCountAction.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  it("requires a non-empty reason before Confirm is enabled", () => {
    render(<ReviewActions sessionId="s1" labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel count" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Reason for cancellation", { exact: false }), { target: { value: "Wrong warehouse" } });
    expect(confirmButton.disabled).toBe(false);
  });

  it("keeps the dialog open with the reason intact when the cancel submit fails", async () => {
    cancelStockCountAction.mockResolvedValueOnce({ ok: false, error: "errors.COUNT_ALREADY_POSTED" });
    render(<ReviewActions sessionId="s1" labels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel count" }));
    fireEvent.change(screen.getByLabelText("Reason for cancellation", { exact: false }), { target: { value: "Started too early" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText("Already posted")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Reason for cancellation", { exact: false }) as HTMLTextAreaElement).value)
      .toBe("Started too early");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("closes, clears the reason, and refreshes on a successful cancel", async () => {
    cancelStockCountAction.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } });
    render(<ReviewActions sessionId="s1" labels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel count" }));
    fireEvent.change(screen.getByLabelText("Reason for cancellation", { exact: false }), { target: { value: "Started too early" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("passes the exact cancellation reason typed, as its own form field, to cancelStockCountAction", async () => {
    cancelStockCountAction.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } });
    render(<ReviewActions sessionId="s1" labels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel count" }));
    fireEvent.change(screen.getByLabelText("Reason for cancellation", { exact: false }), { target: { value: "Started too early" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(cancelStockCountAction).toHaveBeenCalledTimes(1));
    const fd = cancelStockCountAction.mock.calls[0][0] as FormData;
    expect(fd.get("sessionId")).toBe("s1");
    expect(fd.get("reason")).toBe("Started too early");
  });
});

const recountLabels = {
  confirmTitle: "Send this line back for recounting?",
  confirmMessage: "This clears the counted quantity for this line and returns the whole count to counting.",
  confirmLabel: "Confirm",
  dismissLabel: "Cancel",
};

function renderRecountButton() {
  return render(
    <RecountButton
      lineId="line-drift1"
      label="Recount"
      loadingLabel="Loading..."
      confirmTitle={recountLabels.confirmTitle}
      confirmMessage={recountLabels.confirmMessage}
      confirmLabel={recountLabels.confirmLabel}
      dismissLabel={recountLabels.dismissLabel}
      errors={labels.errors}
    />,
  );
}

describe("RecountButton", () => {
  beforeEach(() => {
    requestRecountAction.mockReset();
    refresh.mockReset();
  });

  // Finding 2: requestRecount doesn't just clear this one line — it also
  // flips the WHOLE session from REVIEW back to OPEN, which throws the
  // reviewer straight out of review (this page's own OPEN guard redirects to
  // the counting screen). Clicking the trigger alone must NOT fire the
  // action; only confirming the dialog may.
  it("shows a confirmation dialog stating the session-wide consequence before requesting a recount, and does not call the action until confirmed", () => {
    renderRecountButton();

    fireEvent.click(screen.getByRole("button", { name: "Recount" }));

    expect(requestRecountAction).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(recountLabels.confirmTitle)).toBeTruthy();
    expect(screen.getByText(recountLabels.confirmMessage)).toBeTruthy();
  });

  it("requests a recount for its own line and refreshes on success, only after the dialog is confirmed", async () => {
    requestRecountAction.mockResolvedValueOnce({ ok: true, data: { lineId: "line-drift1" } });
    renderRecountButton();

    fireEvent.click(screen.getByRole("button", { name: "Recount" }));
    expect(requestRecountAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(requestRecountAction).toHaveBeenCalledTimes(1);
    const fd = requestRecountAction.mock.calls[0][0] as FormData;
    expect(fd.get("lineId")).toBe("line-drift1");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("does not request a recount when the confirmation dialog is dismissed", () => {
    renderRecountButton();

    fireEvent.click(screen.getByRole("button", { name: "Recount" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(requestRecountAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fires exactly one requestRecountAction call when Confirm is clicked twice synchronously", () => {
    requestRecountAction.mockImplementation(() => new Promise(() => {}));
    renderRecountButton();

    fireEvent.click(screen.getByRole("button", { name: "Recount" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    confirmButton.click();
    confirmButton.click();

    expect(requestRecountAction).toHaveBeenCalledTimes(1);
  });
});

/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CountEntryForm, type CountEntryLine, type CountEntryFormLabels } from "./CountEntryForm";

afterEach(cleanup);

const push = vi.fn();
const refresh = vi.fn();
// `refresh`, not just `push`/`back` (the other Form tests in this codebase
// only need those two) — CountEntryForm's own save flow calls
// `router.refresh()` on every successful record, and a mock without it would
// throw "refresh is not a function" the moment a test actually saves a row.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, back: vi.fn() }) }));

const recordCountAction = vi.fn();
const submitForReviewAction = vi.fn();
vi.mock("../actions", () => ({
  recordCountAction: (...args: unknown[]) => recordCountAction(...args),
  submitForReviewAction: (...args: unknown[]) => submitForReviewAction(...args),
}));

const labels: CountEntryFormLabels = {
  product: "Product", variant: "Variant", sku: "SKU", countedQty: "Counted quantity", status: "Status",
  counted: "Counted", notCounted: "Not counted", recount: "Recount",
  save: "Save", loading: "Saving…", submitForReview: "Submit for review",
  progressTemplate: "{counted} of {total} counted",
  errors: { "errors.generic": "Something went wrong" },
};

function line(overrides: Partial<CountEntryLine> & { id: string }): CountEntryLine {
  return {
    countedQty: null, recountRequested: false, productName: "Product", variantName: null, sku: "SKU-1",
    ...overrides,
  };
}

describe("CountEntryForm", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    recordCountAction.mockReset();
    submitForReviewAction.mockReset();
  });

  // Finding 1: createStockCount makes one StockCountLine per variant, so two
  // sizes of the same shirt used to render as two rows with identical
  // product name and SKU — nothing told the counter which was which.
  it("renders two variant lines of the same product distinguishably", () => {
    const lines = [
      line({ id: "l1", productName: "Shirt", variantName: "Red / M", sku: "SHIRT-RED-M" }),
      line({ id: "l2", productName: "Shirt", variantName: "Red / L", sku: "SHIRT-RED-L" }),
    ];

    render(<CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />);

    expect(screen.getByText("Red / M")).toBeTruthy();
    expect(screen.getByText("Red / L")).toBeTruthy();
    expect(screen.getByText("SHIRT-RED-M")).toBeTruthy();
    expect(screen.getByText("SHIRT-RED-L")).toBeTruthy();
  });

  // Finding 2: the old guard was ONE ref value shared by every row
  // (`savingRef.current = line.id`), so saving row A made row B's click a
  // silent no-op — `if (savingRef.current) return` fired before row B's
  // request was ever built, with no error and no visible feedback. Two
  // DIFFERENT rows must be able to save at the same time.
  it("lets two different rows save concurrently instead of one silently discarding the other's click", async () => {
    let resolveRowA: (value: { ok: true }) => void = () => {};
    const pendingRowA = new Promise<{ ok: true }>((resolve) => { resolveRowA = resolve; });
    recordCountAction.mockImplementation((fd: FormData) =>
      fd.get("lineId") === "l1" ? pendingRowA : Promise.resolve({ ok: true }),
    );

    const lines = [line({ id: "l1" }), line({ id: "l2" })];
    render(<CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />);

    const inputs = screen.getAllByRole("spinbutton");
    const buttons = screen.getAllByRole("button", { name: labels.save });

    // Row A: kick off a save that never resolves during this test.
    fireEvent.change(inputs[0], { target: { value: "5" } });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(recordCountAction).toHaveBeenCalledTimes(1));

    // Row B: click Save WHILE row A is still in flight. Row A's own button
    // has by now flipped to the "Saving…" label (labels.loading), so
    // re-querying by the "Save" name would only find row B's — using the
    // reference captured before row A's click sidesteps that and keeps the
    // test's intent explicit: this is the SAME button element, clicked while
    // its sibling row is mid-save. The bug this guards against is this click
    // being swallowed entirely (recordCountAction never called a second
    // time).
    fireEvent.change(inputs[1], { target: { value: "7" } });
    fireEvent.click(buttons[1]);

    await waitFor(() => expect(recordCountAction).toHaveBeenCalledTimes(2));
    expect(recordCountAction.mock.calls[1][0].get("lineId")).toBe("l2");

    // Clean up row A's still-pending promise so it doesn't leak into the
    // next test's timers/microtasks.
    resolveRowA({ ok: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // Finding 3: the override used to be deleted the instant recordCountAction
  // resolved ok, before router.refresh() had landed fresh data — for that
  // one render, valueFor() fell back to the OLD countedQty (null on a first
  // count), and the counter watched their just-typed entry vanish.
  it("keeps the counter's typed entry visible after a successful save, instead of blanking to the stale server value", async () => {
    recordCountAction.mockResolvedValue({ ok: true });
    const lines = [line({ id: "l1" })];
    render(<CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />);

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));

    await waitFor(() => expect(recordCountAction).toHaveBeenCalled());
    // `router.refresh` is mocked as a no-op here, so this component's `lines`
    // prop is still exactly what it was mounted with (countedQty: null) —
    // reproducing the real window between the action resolving and the
    // Server Component's refresh actually landing. The typed value must
    // still be on screen in that window.
    expect(input.value).toBe("12");
  });

  // The other half of the same problem. Keeping the override forever fixes the
  // blank flash but lets the box outlive the truth it stood for — and the flow
  // where that bites is recount: a reviewer nulls countedQty server-side,
  // which is exactly when the counter must see an empty box rather than their
  // own stale number.
  it("clears the typed entry when a recount resets the line server-side", async () => {
    recordCountAction.mockResolvedValue({ ok: true });
    const lines = [line({ id: "l1" })];
    const { rerender } = render(
      <CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />,
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(recordCountAction).toHaveBeenCalled());

    // The save landed: the server now agrees, so authority passes back to it.
    rerender(
      <CountEntryForm
        locale="en" sessionId="s1" labels={labels}
        lines={[line({ id: "l1", countedQty: 12_000 })]}
      />,
    );
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("12");

    // Now a reviewer requests a recount, which nulls countedQty. The box must
    // empty out, not keep showing 12.
    rerender(
      <CountEntryForm
        locale="en" sessionId="s1" labels={labels}
        lines={[line({ id: "l1", countedQty: null, recountRequested: true })]}
      />,
    );
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("");
  });

  // Finding 2 (whole-branch review): a counted zero is a real result — "the
  // shelf is empty" is a finding, not a non-answer — so the save guard must
  // key off string emptiness (`value.trim() === ""`), never falsiness. A
  // guard that treated the parsed quantity as a boolean would silently
  // swallow this exact case, since Number("0") is falsy.
  it("keeps a counted zero saveable, not treated as an empty field", async () => {
    recordCountAction.mockResolvedValue({ ok: true });
    const lines = [line({ id: "l1" })];
    render(<CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />);

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });

    const button = screen.getByRole("button", { name: labels.save }) as HTMLButtonElement;
    // The button must not be disabled for "0" the way it is for "" — a
    // falsiness-based guard would disable it here exactly as it would for an
    // untouched row.
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(recordCountAction).toHaveBeenCalledTimes(1));
    expect(recordCountAction.mock.calls[0][0].get("countedQty")).toBe("0");
  });

  // Finding 2 (whole-branch review): the number input is otherwise anonymous
  // — the visible column header ("Counted quantity") is shared by every row
  // — so a screen-reader user (or anyone using the one-handed, phone-in-a-
  // warehouse-aisle flow this screen is built for) has no way to tell two
  // identical-looking variant rows apart without a per-row aria-label.
  it("gives the counted-quantity input a per-row accessible name, not a shared one", () => {
    const lines = [
      line({ id: "l1", productName: "Shirt", variantName: "Red / M", sku: "SHIRT-RED-M" }),
      line({ id: "l2", productName: "Shirt", variantName: "Red / L", sku: "SHIRT-RED-L" }),
    ];
    render(<CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />);

    // getByRole with `name` throws unless exactly one match exists — this
    // only passes if each row's input carries its OWN accessible name distinct
    // from its sibling's, not the bare "Counted quantity" label both rows'
    // visible column header would otherwise imply.
    const inputM = screen.getByRole("spinbutton", { name: `${labels.countedQty} — Shirt — Red / M` });
    const inputL = screen.getByRole("spinbutton", { name: `${labels.countedQty} — Shirt — Red / L` });
    expect(inputM).not.toBe(inputL);
  });

  // toQty rounds to thousandths, so the stored quantity is not always the
  // string that was typed. The box must show what was STORED — otherwise the
  // counter believes a figure was recorded that was not.
  it("shows the stored quantity, not the typed string, when rounding changed it", async () => {
    recordCountAction.mockResolvedValue({ ok: true });
    const lines = [line({ id: "l1" })];
    const { rerender } = render(
      <CountEntryForm locale="en" sessionId="s1" lines={lines} labels={labels} />,
    );

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1.2345" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(recordCountAction).toHaveBeenCalled());

    // 1.2345 units scales to 1235 thousandths — 1.235 units, not 1.2345.
    rerender(
      <CountEntryForm
        locale="en" sessionId="s1" labels={labels}
        lines={[line({ id: "l1", countedQty: 1235 })]}
      />,
    );
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("1.235");
  });
});

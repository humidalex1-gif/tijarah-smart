/** @vitest-environment jsdom */
import { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { IssueForm } from "./IssueForm";

// vitest.config.ts doesn't set `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) registration (which relies on a global
// `afterEach`) never fires — without this, each test's rendered tree stays
// in the DOM and later tests fail with "multiple elements found".
afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, back: vi.fn() }) }));

const issueStockAction = vi.fn();
const fetchAvailability = vi.fn();
vi.mock("../actions", () => ({
  issueStockAction: (...args: unknown[]) => issueStockAction(...args),
  fetchAvailability: (...args: unknown[]) => fetchAvailability(...args),
}));

const labels = {
  warehouse: "Warehouse", product: "Product", quantity: "Quantity", reason: "Reason", notes: "Notes",
  available: "Available", save: "Save", cancel: "Cancel", confirm: "Confirm", loading: "…",
  confirmTitle: "Confirm issue", confirmMessageTemplate: "Issue {qty} of {product} from {warehouse}?",
  insufficientTemplate: "Only {available} of {product} available",
  reasonLabels: {
    INTERNAL_USE: "Internal use", PROMOTIONAL_USE: "Promotional use", DAMAGED: "Damaged", LOST: "Lost",
  },
  errors: { "errors.generic": "Something went wrong" },
};

const warehouses = [{ id: "wh-1", name: "Main" }];
const products = [{ id: "p-1", nameAr: "منتج", nameEn: "Product 1" }];

// availableFor at wh-1/p-1 is 6 whole units, scaled by QTY_SCALE (1000).
const AVAILABLE_SCALED = 6000;

describe("IssueForm", () => {
  beforeEach(() => {
    issueStockAction.mockReset();
    fetchAvailability.mockReset();
    fetchAvailability.mockResolvedValue(AVAILABLE_SCALED);
    push.mockReset();
  });

  async function fillWarehouseAndProduct() {
    fireEvent.change(screen.getByLabelText("Warehouse", { exact: false }), { target: { value: "wh-1" } });
    fireEvent.change(screen.getByLabelText("Product", { exact: false }), { target: { value: "p-1" } });
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledWith("wh-1", "p-1"));
    // Let the resolved availability commit before reading the DOM — the
    // quantity input's `max` only reflects it once state has settled.
    const quantityInput = screen.getByLabelText("Quantity", { exact: false }) as HTMLInputElement;
    await waitFor(() => expect(quantityInput.max).toBe("6"));
  }

  it("renders the quantity input's max in whole units, not the scaled availability", async () => {
    render(<IssueForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillWarehouseAndProduct();

    const quantityInput = screen.getByLabelText("Quantity", { exact: false }) as HTMLInputElement;
    // Regression guard: this used to be "6000" (the QTY_SCALE-scaled value)
    // instead of "6" (the whole-unit value the merchant actually types).
    expect(quantityInput.max).toBe("6");
  });

  it("does not allow submitting a quantity greater than what's available", async () => {
    render(<IssueForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillWarehouseAndProduct();

    fireEvent.change(screen.getByLabelText("Quantity", { exact: false }), { target: { value: "7" } });

    // Over the 6-unit availability: the enabled Save/Confirm flow must not
    // be reachable — only the disabled placeholder button renders.
    const disabledSave = screen.getByText("Save") as HTMLButtonElement;
    expect(disabledSave.disabled).toBe(true);
  });

  it("allows submitting a quantity within what's available", async () => {
    render(<IssueForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillWarehouseAndProduct();

    fireEvent.change(screen.getByLabelText("Quantity", { exact: false }), { target: { value: "6" } });

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("fires exactly one mutation even when the trigger is confirmed twice while the first call is in flight", async () => {
    let resolveAction: (value: unknown) => void = () => {};
    issueStockAction.mockImplementation(
      () => new Promise((resolve) => { resolveAction = resolve; }),
    );

    render(<IssueForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillWarehouseAndProduct();
    fireEvent.change(screen.getByLabelText("Quantity", { exact: false }), { target: { value: "2" } });

    // Open the dialog and confirm once — this starts an in-flight mutation.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(issueStockAction).toHaveBeenCalledTimes(1));

    // While the first call is still in flight, the trigger must be marked
    // unavailable (ConfirmDialog's `disabled` prop) — a second click must not
    // re-open the dialog or fire a second mutation.
    //
    // aria-disabled, not the `disabled` attribute: ConfirmDialog deliberately
    // keeps the trigger focusable so it can receive focus back when the
    // dialog closes (a real `disabled` is unfocusable, which dropped keyboard
    // users on <body> after every confirm). The click refusal below, not the
    // attribute, is the guarantee that matters here.
    const trigger = screen.getByRole("button", { name: "…" }) as HTMLButtonElement;
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();

    resolveAction({ ok: true, data: {} });
    await waitFor(() => expect(push).toHaveBeenCalled());

    expect(issueStockAction).toHaveBeenCalledTimes(1);
  });

  it("fires exactly one mutation when Confirm is clicked twice synchronously, before React re-renders", async () => {
    // The disabled-trigger test above covers the realistic UI race (click
    // trigger again while a request is in flight, once React has had a
    // chance to re-render in between). This one is stricter, and is what
    // actually caught the gap during manual browser testing: two raw clicks
    // on the SAME Confirm button, dispatched back-to-back inside one `act`
    // batch so BOTH onClick handlers run before React re-renders/removes the
    // button — same as a genuinely fast native double-click, where the
    // browser can deliver two 'click' events before the next paint. A
    // `submitting` STATE check alone does not catch this (both calls read
    // the same stale, pre-update closure value, since React only applies the
    // update on the next render) — confirmed directly against the real app:
    // two identical mutations landed. Only a ref, mutated synchronously
    // before either call returns, closes it.
    issueStockAction.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<IssueForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillWarehouseAndProduct();
    fireEvent.change(screen.getByLabelText("Quantity", { exact: false }), { target: { value: "2" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });

    await waitFor(() => expect(issueStockAction).toHaveBeenCalledTimes(1));
  });

  it("leaves the form usable again after the action call itself rejects (network drop, RSC failure)", async () => {
    // Regression guard: `submittingRef.current = false; setSubmitting(false);`
    // used to run only after a successful await, with no try/finally — a
    // transport-level rejection (the promise itself throwing, not the action
    // resolving with `{ ok: false }`) left the ref/state stuck true forever,
    // permanently disabling the trigger. Before the double-submit fix that
    // path just left the "…" label stuck while the form stayed clickable, so
    // this was a real regression the try/catch/finally below closes.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    issueStockAction.mockRejectedValueOnce(new Error("network drop"));

    render(<IssueForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillWarehouseAndProduct();
    fireEvent.change(screen.getByLabelText("Quantity", { exact: false }), { target: { value: "2" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(issueStockAction).toHaveBeenCalledTimes(1));

    // The trigger must recover — not stay disabled/stuck on "…" — once the
    // rejected promise settles. Checked via aria-disabled, since the trigger
    // is marked unavailable that way rather than with the `disabled`
    // attribute (see ConfirmDialog); `.disabled` would read false here even
    // if the trigger were still stuck, making the assertion vacuous.
    await waitFor(() => {
      const trigger = screen.getByRole("button", { name: "Save" });
      expect(trigger.getAttribute("aria-disabled")).toBeNull();
    });

    // And a fresh confirm must actually reach the server again.
    issueStockAction.mockResolvedValueOnce({ ok: true, data: {} });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(issueStockAction).toHaveBeenCalledTimes(2));

    consoleError.mockRestore();
  });
});

/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { toQty } from "@/lib/money";
import { ReconcileForm } from "./ReconcileForm";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("./actions", () => ({
  postReconcileAction: vi.fn(async () => ({
    ok: true,
    data: {
      settledClaims: toQty(10), shrinkagePosted: 0, damagedPosted: toQty(4),
      skipped: 0, failed: 0, isPhysicalCount: false,
    },
  })),
  previewReconcileAction: vi.fn(async () => ({
    ok: true,
    data: [{
      productId: "p1", variantId: null,
      expectedSellable: toQty(303), expectedDamaged: 0,
      assertedSellable: toQty(300), assertedDamaged: null,
      gap: toQty(3),
      settleableSellable: toQty(2), settleableDamaged: 0,
      stillClaimed: toQty(1), unexplained: toQty(7), surplus: 0,
      damagedDelta: 0, damagedReturns: 0, damagedFromShelf: 0,
    }],
  })),
  fastHubFiguresAction: vi.fn(async () => ({
    ok: true,
    data: {
      lines: [{ productId: "p1", sku: "CB-003", sellable: toQty(14), onHand: toQty(16) }],
      unknownSkus: [],
    },
  })),
}));

const labels = {
  warehouse: "Warehouse", asOf: "As of", product: "Product", sku: "SKU",
  expected: "Expected", sellable: "Sellable", damaged: "Damaged", gap: "Difference",
  settleable: "Settleable", stillClaimed: "Still claimed", unexplained: "Unexplained",
  surplus: "Surplus", isPhysicalCount: "Physical count", isPhysicalCountHint: "Hint",
  preview: "Check figures", onShelf: "On shelf", inDispute: "In dispute",
  fastHub: "From Fast Hub", theirOnHand: "They hold", syncedHint: "Synced figures",
  post: "Post", posted: "Posted.", settledCount: "Settled", shrinkagePosted: "Shrinkage",
  damagedPosted: "Damage written off",
  skippedCount: "Skipped", generic: "Something went wrong",
};

const rows = [
  {
    productId: "p1", variantId: null, name: "كيبل شحن", sku: "CB-003",
    // Distinct parts on purpose: 295 + 8 = 303, and typing 300 gives a gap of
    // 3. Every figure on the row renders as a different string, so a digit
    // assertion cannot pass by matching the wrong cell.
    expectedQty: toQty(303), onShelfQty: toQty(295), inDisputeQty: toQty(8),
  },
];

const warehouses = [{ id: "w1", name: "Riyadh Main Warehouse" }];

function renderForm(locale: "ar" | "en", customRows = rows) {
  return render(
    <ReconcileForm
      locale={locale}
      warehouses={warehouses}
      warehouseId="w1"
      rows={customRows}
      labels={labels}
    />,
  );
}

describe("ReconcileForm result summary", () => {
  it("reports the damage it wrote off, not only the loss and the settlements", async () => {
    // Damage was computed, posted and never shown. A merchant who reconciles a
    // line that writes off 4 units sees "Loss posted: 0" and concludes nothing
    // happened — the same silence that let an inert feature ship unnoticed for
    // eight tasks in this project.
    renderForm("en");
    fireEvent.change(screen.getByLabelText(/Sellable/), { target: { value: "300" } });
    fireEvent.click(screen.getByText("Post"));

    const summary = await screen.findByText(/Posted\./);
    expect(summary.textContent).toContain("Damage written off: 4");
  });
});

describe("ReconcileForm digits", () => {
  // Every other screen renders quantities through formatQty. This one reached
  // for the raw descaler, so the Arabic UI showed "303" next to money rendered
  // as ٣٠٣٫٠٠ ر.س. — a defect invisible in English.
  it("renders the expected quantity in Arabic-Indic digits under /ar", () => {
    renderForm("ar");
    expect(screen.getByText("٣٠٣")).toBeTruthy();
    expect(screen.queryByText("303")).toBeNull();
  });

  it("renders the expected quantity in Western digits under /en", () => {
    renderForm("en");
    expect(screen.getByText("303")).toBeTruthy();
  });

  it("renders the computed difference in the locale's digits", () => {
    renderForm("ar");
    fireEvent.change(screen.getByLabelText(/Sellable/), { target: { value: "300" } });
    expect(screen.getByText("٣")).toBeTruthy();
  });
});

/**
 * The split into settleable / still-claimed / unexplained is the whole product
 * of this screen, and it used to arrive only after an irreversible post. The
 * service and both translations existed; only the button was missing.
 */
describe("ReconcileForm preview", () => {
  // The mocks are module-level and this file's earlier tests post. Without
  // this, "postReconcileAction was not called" passes or fails depending on
  // test order rather than on the component.
  beforeEach(() => vi.clearAllMocks());

  it("shows the server's decomposition without posting", async () => {
    const actions = await import("./actions");
    renderForm("en");
    fireEvent.change(screen.getByLabelText(/Sellable/), { target: { value: "300" } });

    fireEvent.click(screen.getByRole("button", { name: "Check figures" }));
    await screen.findByText(/Unexplained/);

    // The figures the browser cannot compute: it knows nothing about open claims.
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("Unexplained");
    expect(table.textContent).toContain("7");
    expect(table.textContent).toContain("Still claimed");
    expect(actions.previewReconcileAction).toHaveBeenCalled();
    expect(actions.postReconcileAction).not.toHaveBeenCalled();
  });

  it("keeps what was typed, so the preview can be read and then posted", async () => {
    renderForm("en");
    const input = screen.getByLabelText(/Sellable/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "300" } });

    fireEvent.click(screen.getByRole("button", { name: "Check figures" }));
    await screen.findByText(/Unexplained/);

    // Clearing the form on preview would make the button useless: you would
    // have to retype everything to post what you just checked.
    expect(input.value).toBe("300");
  });

  it("cannot be pressed before anything is typed", () => {
    renderForm("en");
    const button = screen.getByRole("button", { name: "Check figures" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  /**
   * The most dangerous state this form could reach: a decomposition of figures
   * that are no longer the ones typed. It looks authoritative and is wrong, and
   * the next click posts the NEW numbers while the owner reads the OLD split.
   */
  it("drops the preview as soon as a figure changes", async () => {
    renderForm("en");
    const input = screen.getByLabelText(/Sellable/);
    fireEvent.change(input, { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Check figures" }));
    await screen.findByText(/Unexplained/);

    fireEvent.change(input, { target: { value: "250" } });

    expect(screen.queryByText(/Unexplained/)).toBeNull();
    expect(screen.queryByText(/Still claimed/)).toBeNull();
  });
});

/**
 * `المتوقّع لديك` silently summed two different things: units on the shelf and
 * units already in dispute — returns on their way back that the warehouse has
 * not confirmed. A merchant comparing that total against what Fast Hub reports
 * is comparing a shelf count against a shelf-plus-in-flight figure, and the
 * discrepancy that falls out looks like loss when it is transit.
 */
describe("ReconcileForm expected breakdown", () => {
  const withDispute = [{
    productId: "p1", variantId: null, name: "كيبل شحن", sku: "CB-003",
    expectedQty: toQty(303), onShelfQty: toQty(298), inDisputeQty: toQty(5),
  }];

  it("shows the shelf and the disputed parts, not only their sum", () => {
    renderForm("en", withDispute);
    const table = screen.getByRole("table");

    expect(table.textContent).toContain("298");
    expect(table.textContent).toContain("5");
    // The total stays: it is the base the difference column is computed from.
    expect(table.textContent).toContain("303");
  });

  it("headings name both parts", () => {
    renderForm("en", withDispute);
    expect(screen.getByText("On shelf")).toBeTruthy();
    expect(screen.getByText("In dispute")).toBeTruthy();
  });
});

/**
 * The owner was reading Fast Hub's figure on the sync screen and retyping it
 * here. A button, never an auto-fill: the empty box is a prompt to go and ask
 * a human at the warehouse, and the design doc holds that getting them to
 * state a number is worth more than any code here. Filling it on page load
 * would quietly remove that prompt.
 */
describe("ReconcileForm Fast Hub prefill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fills the sellable box from Fast Hub and shows their on-hand", async () => {
    renderForm("en");

    fireEvent.click(screen.getByRole("button", { name: "From Fast Hub" }));
    await screen.findByDisplayValue("14");

    const sellable = screen.getByLabelText(/Sellable/) as HTMLInputElement;
    expect(sellable.value).toBe("14");
    // On-hand includes units reserved for a picked-but-unshipped order. Without
    // it, that reservation depresses "sellable" and reads exactly like a loss.
    expect(screen.getByRole("table").textContent).toContain("16");
  });

  it("leaves the damaged box alone, because their API has no such field", async () => {
    renderForm("en");
    const damaged = screen.getByLabelText(/Damaged/) as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "From Fast Hub" }));
    await screen.findByDisplayValue("14");

    expect(damaged.value).toBe("");
  });

  /**
   * A synced figure is Omniful's bookkeeping, not a person committing to a
   * count. Presenting it as a physical count would show a verified loss in the
   * profit waterfall, which is precisely what the caveat exists to prevent.
   */
  it("forces the physical-count box off, and it cannot be re-ticked over synced figures", async () => {
    renderForm("en");
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "From Fast Hub" }));
    await screen.findByDisplayValue("14");

    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
  });
});

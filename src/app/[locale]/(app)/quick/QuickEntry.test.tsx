/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QuickEntry, type QuickEntryLabels } from "./QuickEntry";

/**
 * The quick-entry page is a FACE over operations that already exist. These
 * tests pin the two properties that make that claim true, because both have
 * been broken in this project before:
 *
 *  - nothing on the home screen leads somewhere that is not built (the first
 *    attempt at this page put the nav link in with no page behind it), and
 *  - the save reaches `addExpenseAction` with the same fields the full
 *    expense form sends, so no second write path exists to drift.
 */

const addExpenseAction = vi.hoisted(() =>
  // Typed with the FormData parameter so the assertions below can read what
  // the component actually sent, rather than an empty argument tuple.
  vi.fn(async (_formData: FormData) => ({ ok: true as const, data: { expenseId: "e1" } })),
);

const cancelExpenseAction = vi.hoisted(() =>
  vi.fn(async (_formData: FormData) => ({ ok: true as const, data: { id: "e1" } })),
);
const recordSupplierPaymentAction = vi.hoisted(() =>
  vi.fn(async (_formData: FormData) => ({ ok: true as const, data: { paymentId: "p1", id: "p1" } })),
);

vi.mock("../expenses/actions", () => ({ addExpenseAction, cancelExpenseAction }));
vi.mock("../finance/actions", () => ({ recordSupplierPaymentAction }));
// QuickEntry imports these for stages 2/3; unmocked they drag in next-auth,
// which cannot resolve outside a Next runtime. Stage 2 has its own test file.
vi.mock("../sales/actions", () => ({ createSalesOrderAction: vi.fn() }));
vi.mock("../products/actions", () => ({ createProductAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

afterEach(cleanup);
// Block body: `mockClear()` returns the mock, and a function returned from
// `beforeEach` becomes a Vitest cleanup hook that calls it with no arguments.
beforeEach(() => {
  addExpenseAction.mockClear();
  cancelExpenseAction.mockClear();
  recordSupplierPaymentAction.mockClear();
});

const LABELS: QuickEntryLabels = {
  greeting: "Good evening", salesToday: "Today's sales",
  expense: "Expense", expenseHint: "three taps", sale: "Sale", saleHint: "from the grid",
  product: "Product", productHint: "name and price", payment: "Payment", paymentHint: "to a supplier",
  soon: "Soon", newExpense: "New expense", next: "Continue", category: "Category",
  invoice: "Invoice or receipt", optional: "optional", snap: "Photograph the invoice",
  snapDone: "Invoice attached", snapClear: "Remove", save: "Save expense", saving: "Saving",
  back: "Back", saved: "Saved", fromTemplate: "from {account}",
  newSale: "New sale", total: "Total", recordSale: "Record the sale",
  newProduct: "New product", productName: "Product name", productPrice: "Selling price (SAR)",
  saveProduct: "Save product", productLater: "Cost and SKU are completed later",
  newPayment: "New payment", payTo: "To", savePayment: "Record the payment",
  undo: "Undo", undone: "Entry cancelled", undoReason: "Undone from quick entry",
  errors: { "errors.generic": "Something went wrong" },
};

const CATEGORIES = [
  { id: "c1", nameAr: "إعلانات", nameEn: "Advertising" },
  { id: "c2", nameAr: "شحن", nameEn: "Shipping" },
];

/** This repo asserts on DOM properties directly; jest-dom is not installed. */
function btn(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

type Extra = Partial<Parameters<typeof QuickEntry>[0]>;

function setup(locale: "ar" | "en" = "en", extra: Extra = {}) {
  return render(
    <QuickEntry
      locale={locale}
      currency="SAR"
      categories={CATEGORIES}
      accountId="a1"
      accountName="Cash"
      today={{ revenue: 77_700, ordersLabel: "3 orders" }}
      labels={LABELS}
      {...extra}
    />,
  );
}

const PAYMENT = {
  suppliers: [
    { id: "s1", name: "Fast Hub" },
    { id: "s2", name: "Wuhan Oak Valley Home" },
  ],
};

/** Tap the digits of `amount` on the on-screen keypad, in the given locale. */
function tapAmount(amount: string, locale: "ar" | "en") {
  const AR = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  for (const ch of amount) {
    fireEvent.click(btn(locale === "ar" ? AR[Number(ch)]! : ch));
  }
}

/** Walk the three taps: amount, category, save. */
function enterExpense(amount = "50") {
  fireEvent.click(btn(/Expense/));
  tapAmount(amount, "en");
  fireEvent.click(btn("Continue"));
  fireEvent.click(btn("Advertising"));
}

describe("QuickEntry", () => {
  it("offers four entries but enables only the one that is built", () => {
    setup();
    // A button that saves nothing is the same defect as a nav link with no
    // page behind it: it is discovered by being pressed. Stages 2 and 3 turn
    // these three on; until then they say so instead of doing nothing.
    expect(btn(/Expense/).disabled).toBe(false);
    expect(btn(/Sale/).disabled).toBe(true);
    expect(btn(/Product/).disabled).toBe(true);
    expect(btn(/Payment/).disabled).toBe(true);
  });

  it("shows today's sales without recomputing them", () => {
    setup();
    expect(screen.getByText("SAR 777.00")).not.toBeNull();
    expect(screen.getByText("3 orders")).not.toBeNull();
  });

  it("renders the keypad and the figure in Arabic digits under /ar", () => {
    setup("ar");
    fireEvent.click(btn(/Expense/));
    tapAmount("50", "ar");
    // Western digits under /ar is a bug this project has already shipped once,
    // on the reconcile screen.
    expect(btn("٥")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "5" })).toBeNull();
    expect(screen.getByTestId("quick-amount").textContent).toContain("٥٠");
  });

  it("refuses to continue until the amount is above zero", () => {
    setup();
    fireEvent.click(btn(/Expense/));
    expect(btn("Continue").disabled).toBe(true);
    tapAmount("0", "en");
    // Zero typed is still zero: an expense of nothing is a mis-tap, not an entry.
    expect(btn("Continue").disabled).toBe(true);
    tapAmount("5", "en");
    expect(btn("Continue").disabled).toBe(false);
  });

  it("will not save before a category is chosen", () => {
    setup();
    fireEvent.click(btn(/Expense/));
    tapAmount("50", "en");
    fireEvent.click(btn("Continue"));
    expect(btn("Save expense").disabled).toBe(true);
    fireEvent.click(btn("Advertising"));
    expect(btn("Save expense").disabled).toBe(false);
  });

  it("saves through addExpenseAction with the category, the default account and the amount", async () => {
    setup();
    enterExpense();
    fireEvent.click(btn("Save expense"));

    await vi.waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(1));
    const fd = addExpenseAction.mock.calls[0]![0] as unknown as FormData;
    expect(fd.get("amount")).toBe("50");
    expect(fd.get("categoryId")).toBe("c1");
    // The action requires both, and the page collects neither: the account is
    // the company's first active one, and the description is the category —
    // otherwise the expense list would show a blank line for every quick entry.
    expect(fd.get("accountId")).toBe("a1");
    expect(fd.get("description")).toBe("Advertising");
    // Never sent when no photo was taken: an empty File fails saveUpload's
    // size guard and would refuse an expense that never wanted a document.
    expect(fd.get("file")).toBeNull();
  });

  it("sends the photographed invoice through the same attachment path", async () => {
    const { container } = setup();
    enterExpense();

    const photo = new File(["x"], "invoice.jpg", { type: "image/jpeg" });
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [photo] } });
    fireEvent.click(btn("Save expense"));

    await vi.waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(1));
    const fd = addExpenseAction.mock.calls[0]![0] as unknown as FormData;
    expect((fd.get("file") as File).name).toBe("invoice.jpg");
  });

  it("returns to the home screen after a save, so the next entry is one tap away", async () => {
    setup();
    enterExpense();
    fireEvent.click(btn("Save expense"));

    await screen.findByText("Saved");
    expect(btn(/Expense/).disabled).toBe(false);
  });

  it("keeps the entry on screen when the save fails", async () => {
    addExpenseAction.mockResolvedValueOnce(
      { ok: false, error: "errors.generic", code: "UNEXPECTED" } as never,
    );
    setup();
    enterExpense();
    fireEvent.click(btn("Save expense"));

    // Bouncing home on a failure loses the entry silently and reads as success.
    await screen.findByText("Something went wrong");
    expect(btn("Save expense").disabled).toBe(false);
  });

  it("offers an undo after a saved expense, through the real cancel action", async () => {
    setup("en", { canUndo: true });
    enterExpense();
    fireEvent.click(btn("Save expense"));
    await screen.findByText("Saved");

    fireEvent.click(btn("Undo"));

    await vi.waitFor(() => expect(cancelExpenseAction).toHaveBeenCalledTimes(1));
    const fd = cancelExpenseAction.mock.calls[0]![0] as unknown as FormData;
    // The id the SAVE returned, not a guess — and a reason, because the cancel
    // action refuses without one and the audit trail keeps it.
    expect(fd.get("expenseId")).toBe("e1");
    expect(fd.get("reason")).toBe("Undone from quick entry");
    await screen.findByText("Entry cancelled");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers no undo to a role that cannot cancel expenses", async () => {
    setup("en", { canUndo: false });
    enterExpense();
    fireEvent.click(btn("Save expense"));
    await screen.findByText("Saved");

    // A button whose action would refuse is the defect this page exists to
    // avoid; without `expenses.cancel` the toast simply reports the save.
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps the entry saved and says so when the undo itself fails", async () => {
    cancelExpenseAction.mockResolvedValueOnce(
      { ok: false, error: "errors.generic", code: "UNEXPECTED" } as never,
    );
    setup("en", { canUndo: true });
    enterExpense();
    fireEvent.click(btn("Save expense"));
    await screen.findByText("Saved");

    fireEvent.click(btn("Undo"));

    await screen.findByText("Something went wrong");
    // Not "cancelled": the expense still exists, and saying otherwise would
    // be a success message about a failure.
    expect(screen.queryByText("Entry cancelled")).toBeNull();
  });

  it("keeps the payment tile disabled until the page supplies suppliers", () => {
    setup();
    expect(btn(/Payment/).disabled).toBe(true);
  });

  it("records a payment to a chosen supplier through the real payment action", async () => {
    setup("en", { payment: PAYMENT });
    fireEvent.click(btn(/Payment/));
    tapAmount("75", "en");
    fireEvent.click(btn("Fast Hub"));
    fireEvent.click(btn("Record the payment"));

    await vi.waitFor(() => expect(recordSupplierPaymentAction).toHaveBeenCalledTimes(1));
    const fd = recordSupplierPaymentAction.mock.calls[0]![0] as unknown as FormData;
    expect(fd.get("supplierId")).toBe("s1");
    // The same named-on-screen default account the expense path uses.
    expect(fd.get("accountId")).toBe("a1");
    expect(fd.get("amount")).toBe("75");
    await screen.findByText("Saved");
  });

  it("will not record a payment before both an amount and a supplier exist", () => {
    setup("en", { payment: PAYMENT });
    fireEvent.click(btn(/Payment/));

    expect(btn("Record the payment").disabled).toBe(true);
    tapAmount("75", "en");
    expect(btn("Record the payment").disabled).toBe(true);
    fireEvent.click(btn("Fast Hub"));
    expect(btn("Record the payment").disabled).toBe(false);
  });

  it("never carries an expense's undo across to a later payment's toast", async () => {
    // The dangerous sequence: save an expense (id remembered for undo), then
    // record a payment. If any hop forgets to clear the remembered id, the
    // payment's toast offers an Undo that would cancel the EXPENSE.
    setup("en", { payment: PAYMENT, canUndo: true });
    enterExpense();
    fireEvent.click(btn("Save expense"));
    await screen.findByText("Saved");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();

    fireEvent.click(btn(/Payment/));
    tapAmount("75", "en");
    fireEvent.click(btn("Fast Hub"));
    fireEvent.click(btn("Record the payment"));

    await screen.findByText("Saved");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(cancelExpenseAction).not.toHaveBeenCalled();
  });

  it("offers no undo after a payment, which has its own screen for that", async () => {
    setup("en", { payment: PAYMENT, canUndo: true });
    fireEvent.click(btn(/Payment/));
    tapAmount("75", "en");
    fireEvent.click(btn("Fast Hub"));
    fireEvent.click(btn("Record the payment"));

    await screen.findByText("Saved");
    // `cancelExpenseAction` cancels EXPENSES; wiring it under a payment toast
    // would refuse at best and cancel the wrong record at worst.
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

/**
 * Leaving a flow half-finished must not hand the next flow the figure you
 * typed for the one you abandoned. This is the only defect in the quick-entry
 * screen that can move real money: `go()` cleared the toast state and left the
 * entry fields standing, so an abandoned expense of 250 became a supplier
 * payment of 250 one tap later.
 */
describe("QuickEntry abandoning a flow", () => {
  it("does not carry a typed amount from an abandoned expense into a payment", () => {
    setup("en", { payment: { suppliers: [{ id: "s1", name: "Fast Hub" }] } });

    // Type 250 on the expense keypad, then walk out without saving.
    fireEvent.click(btn(/Expense/));
    ["2", "5", "0"].forEach((key) => fireEvent.click(btn(key)));
    expect(screen.getByTestId("quick-amount").textContent).toBe("250");
    fireEvent.click(btn(/Back/));

    // One tap later, on a screen whose Save moves money to a supplier.
    fireEvent.click(btn(/Payment/));
    expect(screen.getByTestId("quick-pay-amount").textContent).toBe("0");
  });

  it("keeps the amount while the expense flow is still running", () => {
    // The reset must fire on the way OUT of a flow, not on every navigation:
    // the amount screen's own Continue button goes to the category screen, and
    // the back arrow there returns to the amount — both inside one expense.
    setup("en");

    fireEvent.click(btn(/Expense/));
    ["4", "0"].forEach((key) => fireEvent.click(btn(key)));
    fireEvent.click(btn(/Continue/));
    fireEvent.click(btn(/Back/));

    expect(screen.getByTestId("quick-amount").textContent).toBe("40");
  });
});

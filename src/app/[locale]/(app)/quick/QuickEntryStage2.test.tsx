/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QuickEntry, type QuickEntryLabels } from "./QuickEntry";

/**
 * Stage 2: the sale and product buttons come alive.
 *
 * Same contract as stage 1, and the tests exist to hold it: every save calls
 * an EXISTING tested action verbatim — `createSalesOrderAction` is the same
 * one submit the full sale form makes (create + confirm in one), and
 * `createProductAction` is the products screen's own. No second write path,
 * so nothing here can move a number the full screens could not.
 */

const addExpenseAction = vi.hoisted(() => vi.fn(async (_fd: FormData) => ({ ok: true as const, data: { expenseId: "e1" } })));
const createSalesOrderAction = vi.hoisted(() => vi.fn(async (_fd: FormData) => ({ ok: true as const, data: { salesOrderId: "s1", salesOrderNumber: "SO-0015" } })));
const createProductAction = vi.hoisted(() => vi.fn(async (_fd: FormData) => ({ ok: true as const, data: { id: "p9" } })));

// QuickEntry now also imports the cancel and supplier-payment actions (undo
// and stage 3); unmocked they drag next-auth in, which cannot resolve here.
vi.mock("../expenses/actions", () => ({ addExpenseAction, cancelExpenseAction: vi.fn() }));
vi.mock("../finance/actions", () => ({ recordSupplierPaymentAction: vi.fn() }));
vi.mock("../sales/actions", () => ({ createSalesOrderAction }));
vi.mock("../products/actions", () => ({ createProductAction }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

afterEach(cleanup);
beforeEach(() => {
  addExpenseAction.mockClear();
  createSalesOrderAction.mockClear();
  createProductAction.mockClear();
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
  errors: { "errors.generic": "Something went wrong", "errors.INSUFFICIENT_STOCK": "Not enough stock" },
};

const PRODUCTS = [
  { id: "p1", nameAr: "الوعاء الأحفوري - ركن", nameEn: "Corner caddy", sellingPrice: 7100 },
  { id: "p2", nameAr: "قاعدة تجفيف الصحون", nameEn: "Dish rack", sellingPrice: 29900 },
];

function setup(over: Partial<Parameters<typeof QuickEntry>[0]> = {}) {
  return render(
    <QuickEntry
      locale="en"
      currency="SAR"
      categories={[{ id: "c1", nameAr: "إعلانات", nameEn: "Advertising" }]}
      accountId="a1"
      accountName="Cash"
      labels={LABELS}
      sale={{ warehouseId: "w1", products: PRODUCTS }}
      productEntry
      {...over}
    />,
  );
}

function btn(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("QuickEntry stage 2 — gates", () => {
  it("keeps sale and product disabled when their props are absent", () => {
    setup({ sale: undefined, productEntry: false });

    // Absence of the prop IS the permission gate the page computed. A live
    // button whose action would refuse teaches the owner the page is broken.
    expect(btn(/Sale/).disabled).toBe(true);
    expect(btn(/Product/).disabled).toBe(true);
    expect(btn(/Payment/).disabled).toBe(true);
  });

  it("enables them when the page provides the data", () => {
    setup();
    expect(btn(/Sale/).disabled).toBe(false);
    expect(btn(/Product/).disabled).toBe(false);
    // Stage 3, still honest about it.
    expect(btn(/Payment/).disabled).toBe(true);
  });
});

describe("QuickEntry stage 2 — sale", () => {
  it("shows the grid with prices and refuses to record an empty sale", () => {
    setup();
    fireEvent.click(btn(/Sale/));

    expect(screen.getByText("Corner caddy")).not.toBeNull();
    expect(screen.getByText("SAR 71.00")).not.toBeNull();
    expect(btn("Record the sale").disabled).toBe(true);
  });

  it("totals quantity times price as quantities change", () => {
    setup();
    fireEvent.click(btn(/Sale/));

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[1]!);

    // 2 x 71.00 + 1 x 299.00
    expect(screen.getByTestId("quick-sale-total").textContent).toContain("441.00");
    expect(btn("Record the sale").disabled).toBe(false);
  });

  it("cannot step a quantity below zero", () => {
    setup();
    fireEvent.click(btn(/Sale/));

    fireEvent.click(screen.getAllByRole("button", { name: "-" })[0]!);

    expect(screen.getByTestId("quick-sale-total").textContent).toContain("0.00");
    expect(btn("Record the sale").disabled).toBe(true);
  });

  it("records through createSalesOrderAction exactly as the full form would", async () => {
    setup();
    fireEvent.click(btn(/Sale/));
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]!);
    fireEvent.click(btn("Record the sale"));

    await vi.waitFor(() => expect(createSalesOrderAction).toHaveBeenCalledTimes(1));
    const fd = createSalesOrderAction.mock.calls[0]![0] as unknown as FormData;

    expect(fd.get("warehouseId")).toBe("w1");
    const lines = JSON.parse(String(fd.get("linesJson"))) as Record<string, unknown>[];
    expect(lines).toEqual([{
      productId: "p1",
      quantity: 2,
      // SAR, not minor units: the ACTION converts via toMinor, exactly as it
      // does for the full form. Sending minor here would book a 100x price.
      unitPrice: 71,
      // Zero on purpose: every real SokuDry order (the Fast Hub import) books
      // tax-inclusive storefront prices with taxRatePct 0. Quick sales match
      // the books, not the full form's company-default suggestion.
      taxRatePct: 0,
    }]);
    expect(String(fd.get("costsJson"))).toBe("[]");
    // Paid in full into the named account: a quick sale is cash in hand, and
    // an unpaid sale against NO customer is a receivable nobody can see.
    expect(fd.get("paidAmount")).toBe("142");
    expect(fd.get("accountId")).toBe("a1");
    expect(fd.get("customerId")).toBeNull();
  });

  it("keeps the entry on screen when the confirm refuses", async () => {
    createSalesOrderAction.mockResolvedValueOnce(
      { ok: false, error: "errors.INSUFFICIENT_STOCK", code: "INSUFFICIENT_STOCK" } as never,
    );
    setup();
    fireEvent.click(btn(/Sale/));
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]!);
    fireEvent.click(btn("Record the sale"));

    expect(await screen.findByText("Not enough stock")).not.toBeNull();
    expect(btn("Record the sale")).not.toBeNull();
  });

  it("returns home with quantities cleared after a recorded sale", async () => {
    setup();
    fireEvent.click(btn(/Sale/));
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]!);
    fireEvent.click(btn("Record the sale"));

    await screen.findByText("Saved");
    fireEvent.click(btn(/Sale/));
    expect(screen.getByTestId("quick-sale-total").textContent).toContain("0.00");
  });
});

describe("QuickEntry stage 2 — product", () => {
  it("refuses to save without both a name and a positive price", () => {
    setup();
    fireEvent.click(btn(/Product/));

    expect(btn("Save product").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "وعاء جديد" } });
    expect(btn("Save product").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Selling price (SAR)"), { target: { value: "45" } });
    expect(btn("Save product").disabled).toBe(false);
  });

  it("saves through createProductAction with a PENDING sku and the name in both languages", async () => {
    setup();
    fireEvent.click(btn(/Product/));
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "وعاء جديد" } });
    fireEvent.change(screen.getByLabelText("Selling price (SAR)"), { target: { value: "45" } });
    fireEvent.click(btn("Save product"));

    await vi.waitFor(() => expect(createProductAction).toHaveBeenCalledTimes(1));
    const fd = createProductAction.mock.calls[0]![0] as unknown as FormData;

    // The action requires nameAr, nameEn and sku; the form asks one name.
    // Both languages get it — the full products screen refines later.
    expect(fd.get("nameAr")).toBe("وعاء جديد");
    expect(fd.get("nameEn")).toBe("وعاء جديد");
    expect(fd.get("sellingPrice")).toBe("45");
    // PENDING- is this project's established convention for "real SKU not
    // captured yet": such products deliberately do not sync with Fast Hub
    // until the owner replaces the code — the honest failure mode.
    expect(String(fd.get("sku"))).toMatch(/^PENDING-/);
    expect(fd.get("trackInventory")).toBe("on");
    // NO opening stock: that would invent inventory the shelf does not hold.
    expect(fd.get("openingQty")).toBeNull();
  });

  it("keeps the form on screen when the save fails", async () => {
    createProductAction.mockResolvedValueOnce(
      { ok: false, error: "errors.generic", code: "UNEXPECTED" } as never,
    );
    setup();
    fireEvent.click(btn(/Product/));
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "س" } });
    fireEvent.change(screen.getByLabelText("Selling price (SAR)"), { target: { value: "9" } });
    fireEvent.click(btn("Save product"));

    expect(await screen.findByText("Something went wrong")).not.toBeNull();
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("س");
  });
});

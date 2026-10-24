/** @vitest-environment jsdom */
import { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TransferForm } from "./TransferForm";

// vitest.config.ts doesn't set `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) registration never fires on its own.
afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, back: vi.fn() }) }));

const createTransferAction = vi.fn();
const fetchAvailability = vi.fn();
vi.mock("../actions", () => ({
  createTransferAction: (...args: unknown[]) => createTransferAction(...args),
  fetchAvailability: (...args: unknown[]) => fetchAvailability(...args),
}));

const labels = {
  source: "Source", destination: "Destination", product: "Product", quantity: "Quantity",
  available: "Available", notes: "Notes", addLine: "Add line", removeLine: "Remove",
  save: "Save", cancel: "Cancel", confirm: "Confirm", loading: "…",
  confirmTitle: "Confirm transfer", confirmMessageTemplate: "Transfer from {source} to {destination}?",
  errors: { "errors.SAME_WAREHOUSE": "Source and destination must differ", "errors.generic": "Something went wrong" },
};

const warehouses = [{ id: "wh-1", name: "Main" }, { id: "wh-2", name: "Branch" }];
const products = [{ id: "p-1", nameAr: "منتج", nameEn: "Product 1" }];

// availableFor at wh-1/p-1 is 6 whole units, scaled by QTY_SCALE (1000).
const AVAILABLE_SCALED = 6000;

describe("TransferForm", () => {
  beforeEach(() => {
    createTransferAction.mockReset();
    fetchAvailability.mockReset();
    fetchAvailability.mockResolvedValue(AVAILABLE_SCALED);
    push.mockReset();
  });

  async function fillLine() {
    fireEvent.change(screen.getByLabelText("Source", { exact: false }), { target: { value: "wh-1" } });
    fireEvent.change(screen.getByLabelText("Destination", { exact: false }), { target: { value: "wh-2" } });
    fireEvent.change(screen.getByLabelText("Product", { exact: false }), { target: { value: "p-1" } });
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledWith("wh-1", "p-1"));
    const quantityInput = screen.getByLabelText("Quantity", { exact: false }) as HTMLInputElement;
    await waitFor(() => expect(quantityInput.max).toBe("6"));
    return quantityInput;
  }

  it("renders the line quantity input's max in whole units, not the scaled availability", async () => {
    render(<TransferForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    const quantityInput = await fillLine();

    // AVAILABLE_SCALED is 6000 (6 whole units * QTY_SCALE 1000) — the input's
    // `max` must be the descaled "6", not the raw scaled value, or a user
    // could never type in a quantity anywhere near what's actually available.
    expect(quantityInput.max).toBe("6");
    expect(quantityInput.max).not.toBe(String(AVAILABLE_SCALED));
  });

  it("does not allow submitting a line quantity greater than what's available at the source", async () => {
    render(<TransferForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    const quantityInput = await fillLine();

    fireEvent.change(quantityInput, { target: { value: "7" } });

    const disabledSave = screen.getByText("Save") as HTMLButtonElement;
    expect(disabledSave.disabled).toBe(true);
  });

  it("allows submitting a line quantity within what's available at the source", async () => {
    render(<TransferForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    const quantityInput = await fillLine();

    fireEvent.change(quantityInput, { target: { value: "6" } });

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("clears displayed availability once the source warehouse is cleared", async () => {
    render(<TransferForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    await fillLine();
    expect(screen.getByText(/Available: 6/)).toBeTruthy();

    // Regression guard: the effect used to `return` early on an empty
    // sourceWarehouseId without clearing `lines[*].available`, leaving the
    // previous source's numbers on screen even though there's no longer a
    // source to compare them against.
    fireEvent.change(screen.getByLabelText("Source", { exact: false }), { target: { value: "" } });

    await waitFor(() => expect(screen.queryByText(/Available: 6/)).toBeNull());
  });

  it("keeps each line's availability keyed to its own product, not array position", async () => {
    // Regression guard: results used to be zipped back onto `prev` by array
    // INDEX inside the state setter — this proves each line ends up showing
    // its OWN product's availability rather than the other line's.
    fetchAvailability.mockImplementation(async (_wh: string, productId: string) => (
      productId === "p-1" ? 6000 : 9000
    ));
    const twoProducts = [...products, { id: "p-2", nameAr: "منتج 2", nameEn: "Product 2" }];

    render(<TransferForm locale="en" warehouses={warehouses} products={twoProducts} labels={labels} />);
    fireEvent.change(screen.getByLabelText("Source", { exact: false }), { target: { value: "wh-1" } });
    fireEvent.change(screen.getByLabelText("Destination", { exact: false }), { target: { value: "wh-2" } });

    let productSelects = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(productSelects[0], { target: { value: "p-1" } });
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledWith("wh-1", "p-1"));

    fireEvent.click(screen.getByText("Add line"));
    productSelects = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(productSelects[1], { target: { value: "p-2" } });
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledWith("wh-1", "p-2"));

    const quantityInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    await waitFor(() => expect(quantityInputs[0].max).toBe("6"));
    await waitFor(() => expect(quantityInputs[1].max).toBe("9"));
  });

  it("fires exactly one mutation when Confirm is clicked twice synchronously, before React re-renders", async () => {
    // Same fix, same test shape as IssueForm.test.tsx's identically-named
    // test — two raw clicks on the SAME Confirm button, dispatched inside
    // one `act` batch so both onClick handlers run before React re-renders,
    // reproduces a genuinely fast native double-click. A `submitting` STATE
    // check alone does not catch this; only a ref, mutated synchronously
    // before either call returns, does.
    createTransferAction.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<TransferForm locale="en" warehouses={warehouses} products={products} labels={labels} />);
    const quantityInput = await fillLine();
    fireEvent.change(quantityInput, { target: { value: "2" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });

    await waitFor(() => expect(createTransferAction).toHaveBeenCalledTimes(1));
  });
});

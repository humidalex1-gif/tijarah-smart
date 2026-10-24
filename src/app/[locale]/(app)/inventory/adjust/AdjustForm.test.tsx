/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AdjustForm } from "./AdjustForm";

afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

const adjustStockAction = vi.fn();
const fetchAvailability = vi.fn();
vi.mock("../actions", () => ({
  adjustStockAction: (...args: unknown[]) => adjustStockAction(...args),
  fetchAvailability: (...args: unknown[]) => fetchAvailability(...args),
}));

const labels = {
  warehouse: "Warehouse", product: "Product", systemQty: "System quantity", countedQty: "Counted quantity",
  difference: "Difference", reason: "Reason", notes: "Notes", save: "Save", cancel: "Cancel", confirm: "Confirm", loading: "…",
  confirmTitle: "Confirm adjustment", confirmMessageTemplate: "Adjust {product} in {warehouse} from {before} to {after}?",
  errors: { "errors.generic": "Something went wrong" },
};

const warehouses = [{ id: "wh-1", name: "Main" }];
const products = [{ id: "p-1", nameAr: "منتج", nameEn: "Product 1" }];

describe("AdjustForm", () => {
  beforeEach(() => {
    adjustStockAction.mockReset();
    fetchAvailability.mockReset();
  });

  it("renders a clean decimal difference instead of a floating-point artifact", async () => {
    // Regression guard: system qty 20.5 -> counted 20.2 used to be computed
    // as a display-domain float subtraction (20.2 - 20.5) and rendered raw,
    // producing "-0.2999999999999972" instead of "-0.3".
    fetchAvailability.mockResolvedValue(20500); // 20.5 units, scaled

    render(<AdjustForm locale="en" warehouses={warehouses} products={products} labels={labels} />);

    fireEvent.change(screen.getByLabelText("Warehouse", { exact: false }), { target: { value: "wh-1" } });
    fireEvent.change(screen.getByLabelText("Product", { exact: false }), { target: { value: "p-1" } });
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledWith("wh-1", "p-1"));

    fireEvent.change(screen.getByLabelText("Counted quantity", { exact: false }), { target: { value: "20.2" } });

    await waitFor(() => {
      expect(screen.getByText("-0.3")).toBeTruthy();
    });
    expect(screen.queryByText(/0\.2999999/)).toBeNull();
  });

  it("renders the difference with Arabic-Indic digits in the ar locale", async () => {
    fetchAvailability.mockResolvedValue(20500);

    render(<AdjustForm locale="ar" warehouses={warehouses} products={products} labels={labels} />);

    fireEvent.change(screen.getByLabelText("Warehouse", { exact: false }), { target: { value: "wh-1" } });
    fireEvent.change(screen.getByLabelText("Product", { exact: false }), { target: { value: "p-1" } });
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledWith("wh-1", "p-1"));

    fireEvent.change(screen.getByLabelText("Counted quantity", { exact: false }), { target: { value: "20.2" } });

    // "-0.3" in Arabic-Indic digits: "٣.٠-".
    await waitFor(() => {
      expect(screen.getByText(/٣/)).toBeTruthy();
    });
    expect(screen.queryByText(/0\.2999999/)).toBeNull();
  });
});

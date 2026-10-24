/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { formatDate } from "@/lib/format";
import { SearchResults, type SearchLabels } from "./SearchResults";

afterEach(cleanup);

/**
 * `globalSearch` selects a status for every product and a status and date
 * for every order, and the page hands all of it to this component — which
 * rendered none of it. An archived product was indistinguishable from a live
 * one, and two orders with similar numbers could only be told apart by
 * opening both.
 */
const labels: SearchLabels = {
  productsTitle: "Products",
  ordersTitle: "Sales",
  noResults: "No results. Try part of the SKU, the name or the order number.",
  sku: "SKU",
  status: { ACTIVE: "Active", ARCHIVED: "Archived", CONFIRMED: "Confirmed" },
};

const products = [
  { id: "p1", sku: "rainy-light-002", nameAr: "وعاء", nameEn: "Rainy light", status: "ACTIVE" },
  { id: "p2", sku: "rainy-light-001", nameAr: "وعاء قديم", nameEn: "Rainy light (old)", status: "ARCHIVED" },
];
const orders = [
  {
    id: "o1", salesOrderNumber: "SO-0012", status: "CONFIRMED", grandTotal: 51_800,
    orderDate: new Date("2026-08-14T00:00:00.000Z"),
  },
];

describe("SearchResults", () => {
  it("says which product is archived", () => {
    render(
      <SearchResults locale="en" currency="SAR" query="rainy" products={products} orders={null} labels={labels} />,
    );
    const archived = screen.getByText("Rainy light (old)").closest("a")!;
    expect(archived.textContent).toContain("Archived");
    // The live one carries its own word too; a badge only on the exception
    // would make "no badge" mean "active", which nobody is told.
    const live = screen.getByText("Rainy light").closest("a")!;
    expect(live.textContent).toContain("Active");
  });

  it("dates each order, so two similar numbers can be told apart", () => {
    render(
      <SearchResults locale="en" currency="SAR" query="SO-00" products={null} orders={orders} labels={labels} />,
    );
    const row = screen.getByText("SO-0012").closest("a")!;
    expect(row.textContent).toContain(formatDate(orders[0].orderDate, "en"));
  });

  it("renders no results as the app's own empty state, not a bare sentence", () => {
    const { container } = render(
      <SearchResults locale="en" currency="SAR" query="zzz" products={[]} orders={[]} labels={labels} />,
    );
    const box = screen.getByText(labels.noResults);
    // EmptyState's signature is the dashed card; a bare <p> has none.
    expect(box.closest(".border-dashed")).not.toBeNull();
    expect(container.querySelector("p.mt-6")).toBeNull();
  });
});

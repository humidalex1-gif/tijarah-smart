import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SallaProductPayload } from "./api";
import { toMinor } from "@/lib/money";

/**
 * The translation layer: Salla's product payload into the shape `compareCosts`
 * consumes. Every fact encoded here was read at docs.salla.dev/5394168e0 on
 * 2026-08-19 — `GET /admin/v2/products`, scope `products.read`, envelope
 * `{ status, success, data, pagination }`, and `cost_price` as a TOP-LEVEL
 * `{ amount, currency }` object, not a field on variants.
 *
 * Money crosses a boundary here, so this is where a cost lands 100x wrong.
 */

const sallaPaginate = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ sallaPaginate }));

// Imported after the mock is registered, matching this repo's page tests: a
// static import of the module under test binds the real ./client first.
const { listSallaProducts } = await import("./api");

/** Drives the mocked walker with one page of payload. */
function servePage(rows: Partial<SallaProductPayload>[]) {
  sallaPaginate.mockImplementation(
    async (
      _companyId: string,
      _path: string,
      _options: unknown,
      onPage: (page: unknown[]) => Promise<void>,
    ) => { await onPage(rows); },
  );
}

const product = (over: Partial<SallaProductPayload> = {}): Partial<SallaProductPayload> => ({
  id: 1,
  sku: "bowl-large-016",
  name: "وعاء كبير",
  status: "sale",
  cost_price: { amount: 12.3, currency: "SAR" },
  ...over,
});

// A BLOCK body, deliberately. `mockReset()` returns the mock itself, and a
// function returned from `beforeEach` is registered by Vitest as a CLEANUP
// hook — so the concise form makes Vitest call the mock with zero arguments
// after every test, and the implementation runs against undefined arguments.
beforeEach(() => { sallaPaginate.mockReset(); });

describe("listSallaProducts", () => {
  it("reads the documented products path", async () => {
    servePage([product()]);

    await listSallaProducts("c1");

    expect(sallaPaginate).toHaveBeenCalledWith(
      "c1", "/products", expect.anything(), expect.any(Function),
    );
  });

  it("carries the cost across as minor units", async () => {
    servePage([product({ cost_price: { amount: 85.45, currency: "SAR" } })]);

    const [row] = await listSallaProducts("c1");

    // Rule 5: money is minor units. 85.45 SAR is 8545, never 85.45 and never
    // 854500 — this is the boundary where a cost lands 100x wrong.
    expect(row!.costMinor).toBe(toMinor(85.45));
    expect(row!.sku).toBe("bowl-large-016");
    expect(row!.name).toBe("وعاء كبير");
  });

  it("accepts an amount Salla sends as a string", async () => {
    // The bulk-price docs show cost_price as a string ("35.00"); the product
    // response shows a number. Both are handled rather than guessed between.
    servePage([product({ cost_price: { amount: "35.00" as unknown as number, currency: "SAR" } })]);

    const [row] = await listSallaProducts("c1");

    expect(row!.costMinor).toBe(toMinor(35));
  });

  it("reports a missing cost as null, never as zero", async () => {
    servePage([product({ cost_price: undefined })]);

    const [row] = await listSallaProducts("c1");

    // Zero is a claim about the cost; null is the absence of one. Collapsing
    // them is what put 45% of revenue on the books at 100% margin.
    expect(row!.costMinor).toBeNull();
  });

  it("reports an unparseable amount as null rather than NaN", async () => {
    servePage([product({ cost_price: { amount: "" as unknown as number, currency: "SAR" } })]);

    const [row] = await listSallaProducts("c1");

    expect(row!.costMinor).toBeNull();
  });

  it("drops deleted products, whose cost must not be offered as a repair", async () => {
    servePage([product({ sku: "live-1", status: "sale" }), product({ sku: "gone-1", status: "deleted" })]);

    const rows = await listSallaProducts("c1");

    expect(rows.map((r) => r.sku)).toEqual(["live-1"]);
  });

  it("keeps hidden and out-of-stock products, which are still real products", async () => {
    servePage([product({ sku: "h", status: "hidden" }), product({ sku: "o", status: "out" })]);

    const rows = await listSallaProducts("c1");

    expect(rows.map((r) => r.sku)).toEqual(["h", "o"]);
  });

  it("skips a product with no SKU instead of matching it to ours by accident", async () => {
    // Bundles in Salla routinely carry no SKU. An empty key would match every
    // one of our products whose SKU is also blank, and silently mis-cost them.
    servePage([product({ sku: "" }), product({ sku: "  " }), product({ sku: "real" })]);

    const rows = await listSallaProducts("c1");

    expect(rows.map((r) => r.sku)).toEqual(["real"]);
  });

  it("accumulates across pages rather than keeping only the last", async () => {
    sallaPaginate.mockImplementation(
      async (
        _c: string, _p: string, _o: unknown,
        onPage: (page: unknown[]) => Promise<void>,
      ) => {
        await onPage([product({ sku: "a" })]);
        await onPage([product({ sku: "b" })]);
      },
    );

    const rows = await listSallaProducts("c1");

    expect(rows.map((r) => r.sku)).toEqual(["a", "b"]);
  });
});

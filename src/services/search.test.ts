import { describe, it, expect, beforeEach } from "vitest";
import { toQty, toMinor } from "@/lib/money";
import { globalSearch } from "./search";
import { receiveStockManual } from "@/services/stock";
import { createSalesOrder } from "@/services/sales";
import {
  makeCompany, makeWarehouse, makeProduct, makeCustomer, makeCtx, resetDb,
} from "../../tests/factories";

/**
 * One box that finds a product by code or name and an order by number.
 *
 * Read-only by construction. The properties worth pinning are the ones that
 * fail silently: a search that is secretly case-sensitive on SKUs looks like
 * "no results", and one that leaks across companies looks like a feature.
 */
describe("globalSearch", () => {
  beforeEach(resetDb);

  async function setup() {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    return { company, warehouse, ctx: makeCtx(company.id) };
  }

  it("finds a product by its SKU, whatever the case", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "Pets-large-005");

    // Fast Hub's SKUs mix case; a human types lowercase. A search that is
    // secretly case-sensitive reads as "we do not have that product".
    expect((await globalSearch(company.id, "pets-large")).products).toHaveLength(1);
    expect((await globalSearch(company.id, "PETS-LARGE")).products).toHaveLength(1);
  });

  it("finds a product by its Arabic name", async () => {
    const { company } = await setup();
    await makeProduct(company.id, { sku: "bowl-1", nameEn: "وعاء كبير" });

    const result = await globalSearch(company.id, "وعاء");

    expect(result.products.map((p) => p.sku)).toEqual(["bowl-1"]);
  });

  it("finds an order by its number", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "sold-001");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(5), unitCost: 0,
    });
    await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(30) }],
    });

    const result = await globalSearch(company.id, "SO-0001");

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.salesOrderNumber).toBe("SO-0001");
  });

  it("returns nothing for a blank query instead of everything", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "anything-001");

    const blank = await globalSearch(company.id, "   ");

    // Blank matching everything turns the search box into a very slow list
    // page, and on a big catalogue a very large RSC payload.
    expect(blank.products).toHaveLength(0);
    expect(blank.orders).toHaveLength(0);
  });

  it("caps each section rather than shipping the whole catalogue", async () => {
    const { company } = await setup();
    for (let i = 0; i < 25; i += 1) {
      await makeProduct(company.id, `caddy-${String(i).padStart(3, "0")}`);
    }

    const result = await globalSearch(company.id, "caddy");

    expect(result.products.length).toBeLessThanOrEqual(20);
  });

  it("never returns another company's rows", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "ours-001");
    const other = await makeCompany("Other Co");
    await makeProduct(other.id, "ours-002");

    const result = await globalSearch(company.id, "ours");

    expect(result.products.map((p) => p.sku)).toEqual(["ours-001"]);
  });
});

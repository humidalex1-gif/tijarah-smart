import { describe, it, expect, beforeEach } from "vitest";
import { toQty, toMinor, toCost } from "@/lib/money";
import { loadOurCosts } from "./ourCosts";
import { receiveStockManual } from "@/services/stock";
import { createSalesOrder, confirmSale } from "@/services/sales";
import { makeCustomer } from "../../../tests/factories";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The books' side of the cost comparison.
 *
 * `avgCost` lives per warehouse on `InventoryBalance`, not on `Product`, and
 * "has this been sold?" is the flag that separates a cost gap which distorts
 * booked profit from one that only understates inventory value. Both are easy
 * to get subtly wrong and neither is visible from the Salla side.
 */
describe("loadOurCosts", () => {
  beforeEach(resetDb);

  async function setup() {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    return { company, warehouse, ctx: makeCtx(company.id) };
  }

  it("reports a product with no balance at all as costing zero, not as missing", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "bowl-large-016");

    const rows = await loadOurCosts(company.id);

    // A product that never had stock has no InventoryBalance row. Dropping it
    // would hide exactly the products this comparison exists to find.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sku).toBe("bowl-large-016");
    expect(rows[0]!.avgCost).toBe(0);
  });

  it("reads avgCost from the balance once stock has been received", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "caddy-long-012");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(10), unitCost: toCost(toMinor(12.5)),
    });

    const rows = await loadOurCosts(company.id);

    expect(rows[0]!.avgCost).toBe(toCost(toMinor(12.5)));
  });

  it("excludes bundles, which have no shelf and no cost of their own", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "real-001");
    const bundle = await makeProduct(company.id, "kitchen-kit-111");
    const { prisma } = await import("@/lib/db");
    await prisma.product.update({ where: { id: bundle.id }, data: { isBundle: true } });

    const rows = await loadOurCosts(company.id);

    expect(rows.map((r) => r.sku)).toEqual(["real-001"]);
  });

  it("does not leak another company's products", async () => {
    const { company } = await setup();
    await makeProduct(company.id, "ours-001");
    const other = await makeCompany("Other Co");
    await makeProduct(other.id, "theirs-001");

    const rows = await loadOurCosts(company.id);

    expect(rows.map((r) => r.sku)).toEqual(["ours-001"]);
  });
  it("marks a product sold only once an order carrying it is confirmed", async () => {
    const { company, warehouse, ctx } = await setup();
    const product = await makeProduct(company.id, "Pets-large-005");
    const customer = await makeCustomer(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(5), unitCost: 0,
    });

    const { salesOrderId } = await createSalesOrder(ctx, {
      customerId: customer.id, warehouseId: warehouse.id,
      items: [{ productId: product.id, quantity: toQty(1), unitPrice: toMinor(199) }],
    });

    // A DRAFT moves no stock and books no profit, so a zero cost on it is not
    // yet urgent — this is the distinction SO-0001 turned on.
    expect((await loadOurCosts(company.id))[0]!.sold).toBe(false);

    await confirmSale(ctx, { salesOrderId });

    expect((await loadOurCosts(company.id))[0]!.sold).toBe(true);
  });
});

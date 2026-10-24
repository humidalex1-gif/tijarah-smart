import { describe, it, expect, beforeEach } from "vitest";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual } from "@/services/stock";
import { previewReconcile } from "@/services/reconcile";
import { explainDifferences } from "@/services/fasthub/explainDifferences";
import { makeCompany, makeWarehouse, makeProduct, makeClaim, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The sync banner said "caddy-coaster: warehouse 90, books 91" and stopped.
 * The reconcile service already knows how to read that gap — which units an
 * open claim accounts for, which are shelf units missing with no claim behind
 * them, which are surplus — and this hands that reading to the banner. The
 * arithmetic is reconcile.ts's and is tested there; what is pinned here is
 * that the banner gets exactly that reading, for the right product, in the
 * right units, and nothing invented for a SKU the books do not know.
 */
describe("explainDifferences", () => {
  beforeEach(resetDb);

  it("gives the banner the reconcile preview's own reading, in whole units", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const caddy = await makeProduct(company.id, "caddy-coaster-015");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: caddy.id, quantity: toQty(10), unitCost: toCost(toMinor(4)),
    });
    await makeClaim(company.id, caddy.id, "RETURN", toQty(3));

    // The differences are stored in units, not thousandths — display copy.
    const explained = await explainDifferences(ctx, [{ sku: "caddy-coaster-015", fastHub: 7, books: 10 }]);

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf: new Date(),
      lines: [{ productId: caddy.id, sellable: toQty(7) }],
    });
    expect(explained["caddy-coaster-015"]).toEqual({
      settleable: (line.settleableSellable + line.settleableDamaged) / 1000,
      stillClaimed: line.stillClaimed / 1000,
      unexplained: line.unexplained / 1000,
      surplus: line.surplus / 1000,
      determinate: line.determinate,
    });
  });

  it("says nothing about a SKU the books do not know", async () => {
    // The sync already lists unknown SKUs separately; an explanation for one
    // would be a number about a product that does not exist.
    const company = await makeCompany();
    await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);

    const explained = await explainDifferences(ctx, [{ sku: "ghost-999", fastHub: 4, books: 0 }]);
    expect(explained).toEqual({});
  });
});

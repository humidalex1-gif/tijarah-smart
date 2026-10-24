import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { saveFastHubCredentials } from "@/services/fasthub/connection";
import { pollFastHub, syncFastHubInventory } from "@/services/fasthub/poll";
import { receiveStockManual } from "@/services/stock";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../../tests/factories";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  await saveFastHubCredentials(company.id, {
    clientId: "c", clientSecret: "s",
    accessToken: "tok", refreshToken: "ref", webhookSecret: null,
  });
  const mat = await makeProduct(company.id, "waves-light-004");
  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: mat.id,
    quantity: toQty(30), unitCost: toCost(toMinor(96)),
  });
  return { company, warehouse, ctx, mat };
}

afterEach(() => vi.restoreAllMocks());

describe("syncFastHubInventory", () => {
  beforeEach(resetDb);

  it("reports the warehouse's figures as ASSERTIONS without writing stock", async () => {
    // The whole product exists because the books and the shelf disagree.
    // Copying Fast Hub's numbers into our balances would erase the very
    // difference the merchant needs to see — so this only ever REPORTS.
    const { company, warehouse, mat } = await setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      data: [{
        hub_code: "FH-Main", sku_code: "waves-light-004", sku_name: "الدعاسة",
        available_quantity: 25, quantity_on_hand: 27, quantity_reserved: 0, uom: "ea",
      }],
    }));

    const report = await syncFastHubInventory(company.id, warehouse.id, "FH-Main");

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].productId).toBe(mat.id);
    expect(report.lines[0].sellable).toBe(toQty(25));
    expect(report.lines[0].booksAvailable).toBe(toQty(30));
    expect(report.lines[0].difference).toBe(toQty(-5));

    // Nothing moved. The reconcile screen decides what to post, not this.
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(30));
    expect(await prisma.inventoryMovement.count({ where: { referenceType: "RECONCILIATION" } })).toBe(0);
  });

  it("names unknown SKUs rather than dropping them from the comparison", async () => {
    const { company, warehouse } = await setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      data: [{
        hub_code: "FH-Main", sku_code: "mystery-01", sku_name: "?",
        available_quantity: 4, quantity_on_hand: 4, quantity_reserved: 0, uom: "ea",
      }],
    }));

    const report = await syncFastHubInventory(company.id, warehouse.id, "FH-Main");

    expect(report.lines).toHaveLength(0);
    expect(report.unknownSkus).toEqual(["mystery-01"]);
  });
});

describe("pollFastHub", () => {
  beforeEach(resetDb);

  it("runs every resource and returns one combined report", async () => {
    const { company, warehouse } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v2/seller/orders")) {
        return jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: "o-1" } });
      }
      if (url.includes("/v2/seller/return_orders")) {
        return jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: "r-1" } });
      }
      return jsonResponse({ data: [] });
    });

    const report = await pollFastHub(company.id, warehouse.id, "FH-Main");

    expect(report.orders).not.toBeNull();
    expect(report.returns).not.toBeNull();
    expect(report.inventory).not.toBeNull();
    expect(report.failures).toEqual([]);
  });

  it("keeps going when one resource fails, and says which", async () => {
    // Each resource carries its own cursor precisely so one failure does not
    // stall the others. Aborting the whole poll would mean a broken returns
    // endpoint silently stopped orders from arriving too.
    const { company, warehouse } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v2/seller/return_orders")) return jsonResponse({ message: "nope" }, 500);
      if (url.includes("/v2/seller/orders")) {
        return jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: "o-1" } });
      }
      return jsonResponse({ data: [] });
    });

    const report = await pollFastHub(company.id, warehouse.id, "FH-Main");

    expect(report.orders).not.toBeNull();
    expect(report.returns).toBeNull();
    expect(report.inventory).not.toBeNull();
    expect(report.failures.map((f) => f.resource)).toEqual(["returns"]);

    // The orders cursor still advanced: its own page was processed fine.
    const row = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId: company.id } });
    expect(row.ordersCursor).toBe("o-1");
    expect(row.returnsCursor).toBeNull();
  });

  it("refuses to poll a company that has not connected Fast Hub", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);

    await expect(pollFastHub(company.id, warehouse.id, "FH-Main")).rejects.toThrow();
  });
});

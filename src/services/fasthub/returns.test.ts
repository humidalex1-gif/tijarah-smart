import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { saveFastHubCredentials } from "@/services/fasthub/connection";
import { syncFastHubReturns } from "@/services/fasthub/returns";
import { receiveStockManual } from "@/services/stock";
import { openClaims } from "@/services/claims";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The returns poller — the reason this project exists.
 *
 * Goods that fail to reach the customer come back and the warehouse does not
 * tell the books. This turns Fast Hub's return stream into stock claims, and
 * settles them at the moment quality control decides sellable vs damaged.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function mockReturns(rows: { list: unknown; detail?: unknown }[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/v2/seller/return_orders")) {
      return jsonResponse({
        data: rows.map((r) => r.list),
        meta: { has_next_page: false, end_cursor: "ret-cur" },
      });
    }
    const match = rows.find((r) => r.detail
      && url.includes(encodeURIComponent((r.detail as { return_order_id: string }).return_order_id)));
    return jsonResponse({ data: match?.detail ?? {} });
  });
}

const listRow = (id: string, status: string, qcStatus = "Pending") => ({
  return_order_id: id, order_id: `SO-${id}`, type: "Customer Return",
  status, oms_qc_status: qcStatus, updated_at: "2026-08-04T10:00:00Z",
});

const detailRow = (id: string, items: { sku_code: string; return_quantity: number }[], extra: Record<string, unknown> = {}) => ({
  return_order_id: id, order_id: `SO-${id}`, items, ...extra,
});

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

describe("syncFastHubReturns", () => {
  beforeEach(resetDb);

  it("opens a claim when goods start coming back, before they are counted", async () => {
    const { company, warehouse, ctx, mat } = await setup();
    mockReturns([{
      list: listRow("RO-1", "New Return Request"),
      detail: detailRow("RO-1", [{ sku_code: "waves-light-004", return_quantity: 2 }]),
    }]);

    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.opened).toBe(1);
    const claims = await openClaims(ctx, {});
    expect(claims).toHaveLength(1);
    expect(claims[0].openQty).toBe(toQty(2));

    // A RETURN enters dispute without leaving available: those units left the
    // shelf when they were SOLD. Expected on-hand RISES by the disputed units.
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(30));
    expect(balance.disputedQty).toBe(toQty(2));
  });

  it("cannot double-claim the same return across two polls", async () => {
    const { company, warehouse, ctx } = await setup();
    const rows = [{
      list: listRow("RO-2", "Return Initiated"),
      detail: detailRow("RO-2", [{ sku_code: "waves-light-004", return_quantity: 3 }]),
    }];
    mockReturns(rows);

    await syncFastHubReturns(company.id, warehouse.id);
    const second = await syncFastHubReturns(company.id, warehouse.id);

    expect(second.opened).toBe(0);
    const claims = await openClaims(ctx, {});
    expect(claims).toHaveLength(1);
    expect(claims[0].openQty).toBe(toQty(3));
  });

  it("settles a QC-passed return back into sellable stock", async () => {
    const { company, warehouse, ctx, mat } = await setup();
    // First poll: the return is on its way.
    mockReturns([{
      list: listRow("RO-3", "Return Initiated"),
      detail: detailRow("RO-3", [{ sku_code: "waves-light-004", return_quantity: 2 }]),
    }]);
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    // Second poll: QC has run and passed both units.
    mockReturns([{
      list: listRow("RO-3", "Return Order QC Processed", "Passed"),
      detail: detailRow("RO-3", [{ sku_code: "waves-light-004", return_quantity: 2 }], {
        oms_qc_status: "Passed",
        items: [{ sku_code: "waves-light-004", return_quantity: 2, qc_passed_quantity: 2, qc_failed_quantity: 0 }],
      }),
    }]);
    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.settledSellable).toBe(toQty(2));
    expect(await openClaims(ctx, {})).toHaveLength(0);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(32));
    expect(balance.disputedQty).toBe(0);
  });

  it("re-polls a settled return harmlessly instead of wedging the cursor forever", async () => {
    // QC_STATUSES holds both "qc processed" and "completed", so a settled
    // return RE-ENTERS the stream when its status advances (and again when a
    // page is re-read after a mid-walk failure). The settle used to run
    // unconditionally, throw CLAIM_SETTLE_EXCEEDS_OPEN on openQty 0, abort
    // the walk before the cursor stored — and every later poll re-threw.
    // The returns feed is the reason this project exists.
    const { company, warehouse, ctx, mat } = await setup();
    mockReturns([{
      list: listRow("RO-9", "Return Initiated"),
      detail: detailRow("RO-9", [{ sku_code: "waves-light-004", return_quantity: 2 }]),
    }]);
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    const qc = () => mockReturns([{
      list: listRow("RO-9", "Return Order QC Processed", "Passed"),
      detail: detailRow("RO-9", [{ sku_code: "waves-light-004", return_quantity: 2 }], {
        oms_qc_status: "Passed",
        items: [{ sku_code: "waves-light-004", return_quantity: 2, qc_passed_quantity: 2, qc_failed_quantity: 0 }],
      }),
    }]);

    qc();
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    // The same return, again — as "completed", or a re-read page. Must not
    // throw, must not settle twice, must not move stock again.
    qc();
    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.settledSellable).toBe(0);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(32));
    // And the cursor advanced: the wedge was the walk aborting before it.
    const connection = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId: company.id } });
    expect(connection.returnsCursor).toBe("ret-cur");
  });

  it("writes a QC-failed return off as damaged, never back into sellable stock", async () => {
    // Booking damaged units as sellable made inventory value RISE on the
    // confirmation of a loss — the defect this whole branch exists to prevent.
    const { company, warehouse, ctx, mat } = await setup();
    mockReturns([{
      list: listRow("RO-4", "Return Initiated"),
      detail: detailRow("RO-4", [{ sku_code: "waves-light-004", return_quantity: 2 }]),
    }]);
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    mockReturns([{
      list: listRow("RO-4", "Return Order QC Processed", "Failed"),
      detail: detailRow("RO-4", [], {
        oms_qc_status: "Failed",
        items: [{ sku_code: "waves-light-004", return_quantity: 2, qc_passed_quantity: 0, qc_failed_quantity: 2 }],
      }),
    }]);
    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.settledDamaged).toBe(toQty(2));
    expect(await openClaims(ctx, {})).toHaveLength(0);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(30));
    expect(balance.damagedQty).toBe(toQty(2));
  });

  it("splits a partially-passed return across both buckets", async () => {
    const { company, warehouse, mat } = await setup();
    mockReturns([{
      list: listRow("RO-5", "Return Initiated"),
      detail: detailRow("RO-5", [{ sku_code: "waves-light-004", return_quantity: 5 }]),
    }]);
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    mockReturns([{
      list: listRow("RO-5", "Return Order QC Processed", "Partially Passed"),
      detail: detailRow("RO-5", [], {
        items: [{ sku_code: "waves-light-004", return_quantity: 5, qc_passed_quantity: 3, qc_failed_quantity: 2 }],
      }),
    }]);
    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.settledSellable).toBe(toQty(3));
    expect(report.settledDamaged).toBe(toQty(2));
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(33));
    expect(balance.damagedQty).toBe(toQty(2));
    expect(balance.disputedQty).toBe(0);
  });

  it("leaves the claim open and reports it when QC gives no per-unit split", async () => {
    // The docs never showed a processed return, so the split may simply not be
    // in the payload. Guessing "all sellable" would hide real damage; the
    // honest move is to leave the claim for the merchant and SAY so.
    const { company, warehouse, ctx } = await setup();
    mockReturns([{
      list: listRow("RO-6", "Return Initiated"),
      detail: detailRow("RO-6", [{ sku_code: "waves-light-004", return_quantity: 4 }]),
    }]);
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    mockReturns([{
      list: listRow("RO-6", "Return Order QC Processed", "Processed"),
      detail: detailRow("RO-6", [{ sku_code: "waves-light-004", return_quantity: 4 }]),
    }]);
    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.settledSellable).toBe(0);
    expect(report.settledDamaged).toBe(0);
    expect(report.qcSplitMissing).toEqual(["RO-6"]);
    expect(await openClaims(ctx, {})).toHaveLength(1);
  });

  it("cancels the claim when the return is rejected", async () => {
    const { company, warehouse, ctx, mat } = await setup();
    mockReturns([{
      list: listRow("RO-7", "Return Initiated"),
      detail: detailRow("RO-7", [{ sku_code: "waves-light-004", return_quantity: 2 }]),
    }]);
    await syncFastHubReturns(company.id, warehouse.id);
    vi.restoreAllMocks();

    mockReturns([{
      list: listRow("RO-7", "Return Request Rejected"),
      detail: detailRow("RO-7", [{ sku_code: "waves-light-004", return_quantity: 2 }]),
    }]);
    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.cancelled).toBe(1);
    expect(await openClaims(ctx, {})).toHaveLength(0);
    // The disputed units go back where they came from: nowhere. They were
    // never on our shelf, so available must be untouched.
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(30));
    expect(balance.disputedQty).toBe(0);
  });

  it("names an unknown SKU instead of inventing a product", async () => {
    const { company, warehouse } = await setup();
    mockReturns([{
      list: listRow("RO-8", "New Return Request"),
      detail: detailRow("RO-8", [{ sku_code: "ghost-sku", return_quantity: 1 }]),
    }]);

    const report = await syncFastHubReturns(company.id, warehouse.id);

    expect(report.opened).toBe(0);
    expect(report.unknownSkus).toEqual(["ghost-sku"]);
  });

  it("stores the resume cursor only after the page is processed", async () => {
    const { company, warehouse } = await setup();
    mockReturns([{
      list: listRow("RO-9", "New Return Request"),
      detail: detailRow("RO-9", [{ sku_code: "waves-light-004", return_quantity: 1 }]),
    }]);

    await syncFastHubReturns(company.id, warehouse.id);

    const row = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId: company.id } });
    expect(row.returnsCursor).toBe("ret-cur");
  });
});

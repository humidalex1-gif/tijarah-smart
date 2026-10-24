import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { saveFastHubCredentials } from "@/services/fasthub/connection";
import { FASTHUB_BASE_URL } from "@/services/fasthub/client";
import {
  fetchHubInventory, fetchOrderById, fetchReturnOrderById, paginateOrders, paginateReturnOrders,
} from "@/services/fasthub/api";
import { makeCompany, resetDb } from "../../../tests/factories";

/**
 * The typed endpoint layer over the raw client, pinned to the paths verified
 * from Omniful's published collection on 2026-08-04 (design spec §9). The
 * paths are load-bearing: V1 order LISTS are dying (2026-07-30) and their
 * order_items are already gone, so orders are listed via V2 and detailed one
 * by one via the V1 by-id endpoint that still carries the items.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function connected() {
  const company = await makeCompany();
  await saveFastHubCredentials(company.id, {
    clientId: "client-abc",
    clientSecret: "secret",
    accessToken: "the-access-token",
    refreshToken: "the-refresh-token",
    webhookSecret: null,
  });
  return company;
}

afterEach(() => vi.restoreAllMocks());

describe("fetchHubInventory", () => {
  beforeEach(resetDb);

  it("hits the documented hub path and returns the rows", async () => {
    const company = await connected();
    const rows = [
      { hub_code: "FH-Main", sku_code: "very-large", sku_name: "الدعاسة", available_quantity: 14, quantity_on_hand: 14, quantity_reserved: 0, uom: "ea" },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ is_success: true, data: rows }));

    const result = await fetchHubInventory(company.id, "FH-Main");

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url.startsWith(`${FASTHUB_BASE_URL}/sales-channel/public/v1/seller/inventory/hubs/FH-Main`)).toBe(true);
    expect(result).toEqual(rows);
  });

  it("passes the update window and UTC timezone when given", async () => {
    const company = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: [] }));

    await fetchHubInventory(company.id, "FH-Main", {
      updatedFrom: "2026-08-01 00:00:00", updatedTo: "2026-08-04 00:00:00",
    });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("updated_from=2026-08-01");
    expect(url).toContain("updated_to=2026-08-04");
    expect(url).toContain("timezone=UTC");
  });

  it("walks page-numbered pages when the response says there are more", async () => {
    const company = await connected();
    const row = (sku: string) => ({ hub_code: "FH-Main", sku_code: sku, sku_name: sku, available_quantity: 1, quantity_on_hand: 1, quantity_reserved: 0, uom: "ea" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [row("a")], meta: { current_page: 1, last_page: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ data: [row("b")], meta: { current_page: 2, last_page: 2 } }));

    const result = await fetchHubInventory(company.id, "FH-Main");

    expect(result.map((r) => r.sku_code)).toEqual(["a", "b"]);
  });
});

describe("fetchOrderById / fetchReturnOrderById", () => {
  beforeEach(resetDb);

  it("reads one order through the V1 by-id path that still carries items", async () => {
    const company = await connected();
    const order = {
      order_id: "SO-1", status_code: "delivered",
      order_items: [{ sku_code: "caddy-short-013", quantity: 1, unit_price: 22, total: 22 }],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: order }));

    const result = await fetchOrderById(company.id, "SO-1");

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url.startsWith(`${FASTHUB_BASE_URL}/sales-channel/public/v1/seller/orders/SO-1`)).toBe(true);
    expect(result.order_items?.[0].sku_code).toBe("caddy-short-013");
  });

  it("reads one return with its per-SKU items", async () => {
    const company = await connected();
    const ret = {
      return_order_id: "RO-1", order_id: "SO-1", status: "Return Order Arrived At Hub",
      items: [{ sku_code: "waves-light-004", return_quantity: 2, delivered_quantity: 2 }],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: ret }));

    const result = await fetchReturnOrderById(company.id, "RO-1");

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url.startsWith(`${FASTHUB_BASE_URL}/sales-channel/public/v1/return_orders/RO-1`)).toBe(true);
    expect(result.items?.[0].return_quantity).toBe(2);
  });
});

describe("paginateOrders / paginateReturnOrders", () => {
  beforeEach(resetDb);

  it("walks the V2 orders cursor and returns the resume cursor", async () => {
    const company = await connected();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        data: [{ order_id: "SO-1", status_code: "new_order", updated_at: "2026-08-04T00:00:00Z" }],
        meta: { has_next_page: false, end_cursor: "cur-1" },
      }));

    const seen: string[] = [];
    const cursor = await paginateOrders(company.id, null, async (page) => {
      seen.push(...page.map((o) => o.order_id));
    });

    expect(seen).toEqual(["SO-1"]);
    expect(cursor).toBe("cur-1");
  });

  it("walks the V2 return orders cursor", async () => {
    const company = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      data: [{ return_order_id: "RO-9", order_id: "SO-9", status: "New Return Request", updated_at: "2026-08-04T00:00:00Z" }],
      meta: { has_next_page: false, end_cursor: "cur-9" },
    }));

    const seen: string[] = [];
    const cursor = await paginateReturnOrders(company.id, null, async (page) => {
      seen.push(...page.map((r) => r.return_order_id));
    });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url.startsWith(`${FASTHUB_BASE_URL}/sales-channel/public/v2/seller/return_orders`)).toBe(true);
    expect(seen).toEqual(["RO-9"]);
    expect(cursor).toBe("cur-9");
  });
});

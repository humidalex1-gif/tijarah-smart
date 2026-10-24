import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { saveFastHubCredentials } from "@/services/fasthub/connection";
import { syncFastHubOrders } from "@/services/fasthub/orders";
import { importFastHubOpeningStock } from "@/services/fasthub/inventory";
import { receiveStockManual } from "@/services/stock";
import { setBundleRecipe } from "@/services/bundles";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../../tests/factories";

/**
 * The orders poller. Every assertion here exists because its absence would
 * corrupt stock silently rather than fail loudly.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** The V2 list row (no items) followed by the V1 by-id detail (with items). */
function mockPages(orders: { list: unknown; detail?: unknown }[]) {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/v2/seller/orders")) {
      return jsonResponse({
        data: orders.map((o) => o.list),
        meta: { has_next_page: false, end_cursor: "cur-end" },
      });
    }
    // The live detail endpoint accepts ONLY `omniful_order_id` — it answers
    // `Please provide a valid order ID` for order_id and for order_alias.
    const match = orders.find((o) => {
      const detail = o.detail as { omniful_order_id?: string } | undefined;
      return detail?.omniful_order_id && url.endsWith(encodeURIComponent(detail.omniful_order_id));
    });
    return jsonResponse({ data: match?.detail ?? {} });
  });
  return spy;
}

/**
 * `omniful_order_id` is the id the DETAIL endpoint takes; `order_id` is the
 * merchant-facing number the detail endpoint rejects. Both ride every list row.
 */
const listRow = (orderId: string, status = "delivered") => ({
  order_id: orderId, omniful_order_id: `omn-${orderId}`,
  status_code: status, updated_at: "2026-08-04T10:00:00Z",
  order_created_at: "2026-08-04T09:00:00Z",
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

describe("syncFastHubOrders", () => {
  beforeEach(resetDb);

  it("creates a confirmed order that depletes stock at the payload's prices", async () => {
    const { company, warehouse, mat } = await setup();
    mockPages([{
      list: listRow("SO-1"),
      detail: {
        order_id: "SO-1", omniful_order_id: "omn-SO-1", status_code: "delivered",
        invoice: { currency: "SAR", shipping_price: 25 },
        order_items: [{ sku_code: "waves-light-004", quantity: 2, unit_price: 260, total: 520 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.created).toBe(1);
    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.status).toBe("CONFIRMED");
    expect(order.externalSource).toBe("FASTHUB");
    expect(order.externalRef).toBe("SO-1");
    expect(order.channel).toBe("FASTHUB");

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(28));
  });

  it("does not create the same order twice when the poll is re-run", async () => {
    const { company, warehouse } = await setup();
    const page = [{
      list: listRow("SO-1"),
      detail: {
        order_id: "SO-1", omniful_order_id: "omn-SO-1", status_code: "delivered",
        order_items: [{ sku_code: "waves-light-004", quantity: 1, unit_price: 260 }],
      },
    }];
    mockPages(page);

    await syncFastHubOrders(company.id, warehouse.id);
    const second = await syncFastHubOrders(company.id, warehouse.id);

    expect(second.created).toBe(0);
    expect(second.alreadySeen).toBe(1);
    expect(await prisma.salesOrder.count()).toBe(1);
  });

  it("raises a confirmed order that Fast Hub later cancels, instead of skipping it silently", async () => {
    // The externalKey check used to answer "alreadySeen" BEFORE the dead-
    // status check ever ran, so an order confirmed on poll N and cancelled at
    // the warehouse afterwards kept its revenue, its COGS and its stock
    // deduction forever — surfacing months later as unexplained surplus.
    // Reversing money is the OWNER's call (cancelSale exists for that); the
    // sync's job is to say it loudly.
    const { company, warehouse } = await setup();
    const shipped = [{
      list: listRow("SO-1"),
      detail: {
        order_id: "SO-1", omniful_order_id: "omn-SO-1", status_code: "delivered",
        order_items: [{ sku_code: "waves-light-004", quantity: 1, unit_price: 260 }],
      },
    }];
    mockPages(shipped);
    await syncFastHubOrders(company.id, warehouse.id);
    vi.restoreAllMocks();

    // The same order re-enters the stream, now cancelled.
    mockPages([{
      list: listRow("SO-1", "cancelled"),
      detail: {
        order_id: "SO-1", omniful_order_id: "omn-SO-1", status_code: "cancelled",
        order_items: [{ sku_code: "waves-light-004", quantity: 1, unit_price: 260 }],
      },
    }]);
    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.cancelledAfterConfirm).toContain("SO-0001");
    // Nothing is reversed automatically: that is a money decision.
    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.status).toBe("CONFIRMED");
  });

  it("leaves an unshipped order as a draft, so stock moves only when goods leave", async () => {
    const { company, warehouse, mat } = await setup();
    mockPages([{
      list: listRow("SO-2", "new_order"),
      detail: {
        order_id: "SO-2", omniful_order_id: "omn-SO-2", status_code: "new_order",
        order_items: [{ sku_code: "waves-light-004", quantity: 3, unit_price: 260 }],
      },
    }]);

    await syncFastHubOrders(company.id, warehouse.id);

    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.status).toBe("DRAFT");
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(30));
  });

  /**
   * The draft revisit. Production lost SO-0001 (518.00 SAR, no stock moved,
   * invisible to every report) to this: an order polled before it shipped is
   * written as a DRAFT, and then TWO independent mechanisms make it
   * unreachable — `importOrder` matches its `externalKey` and calls it
   * `alreadySeen`, and the `search_after` cursor is strictly forward, so the
   * stream never offers it again. Fixing either alone changes nothing.
   *
   * The revisit re-reads drafts BY ID, which is why `omnifulOrderId` is
   * stored: their detail endpoint rejects `order_id` and `order_alias`.
   */
  it("stores the omniful id, without which a draft can never be re-read", async () => {
    const { company, warehouse } = await setup();
    mockPages([{
      list: listRow("SO-2", "new_order"),
      detail: {
        order_id: "SO-2", omniful_order_id: "omn-SO-2", status_code: "new_order",
        order_items: [{ sku_code: "waves-light-004", quantity: 3, unit_price: 260 }],
      },
    }]);

    await syncFastHubOrders(company.id, warehouse.id);

    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.omnifulOrderId).toBe("omn-SO-2");
  });

  it("confirms a draft once it ships, even though the cursor has moved past it", async () => {
    const { company, warehouse, mat } = await setup();
    const unshipped = [{
      list: listRow("SO-2", "new_order"),
      detail: {
        order_id: "SO-2", omniful_order_id: "omn-SO-2", status_code: "new_order",
        order_items: [{ sku_code: "waves-light-004", quantity: 3, unit_price: 260 }],
      },
    }];
    mockPages(unshipped);
    await syncFastHubOrders(company.id, warehouse.id);
    expect((await prisma.salesOrder.findFirstOrThrow()).status).toBe("DRAFT");

    // The next poll: the stream returns NOTHING new — exactly the real case,
    // where the cursor has already passed this order. The only way back to it
    // is the by-id re-read.
    vi.restoreAllMocks();
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v2/seller/orders")) {
        return jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: "cur-end" } });
      }
      return jsonResponse({
        data: {
          order_id: "SO-2", omniful_order_id: "omn-SO-2", status_code: "delivered",
          order_items: [{ sku_code: "waves-light-004", quantity: 3, unit_price: 260 }],
        },
      });
    });

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.draftsConfirmed).toBe(1);
    const order = await prisma.salesOrder.findFirstOrThrow();
    expect(order.status).toBe("CONFIRMED");
    // The whole point: the goods have now left, so the shelf must follow.
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(27));
  });

  it("leaves a draft that still has not shipped, and counts it", async () => {
    const { company, warehouse, mat } = await setup();
    const unshipped = [{
      list: listRow("SO-2", "new_order"),
      detail: {
        order_id: "SO-2", omniful_order_id: "omn-SO-2", status_code: "new_order",
        order_items: [{ sku_code: "waves-light-004", quantity: 3, unit_price: 260 }],
      },
    }];
    mockPages(unshipped);
    await syncFastHubOrders(company.id, warehouse.id);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.draftsConfirmed).toBe(0);
    expect(report.draftsPending).toBe(1);
    expect((await prisma.salesOrder.findFirstOrThrow()).status).toBe("DRAFT");
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(30));
  });

  /**
   * `importOrder` deletes a draft whose confirm throws, so a later poll can
   * re-import it cleanly. The revisit must NOT: the cursor has already passed
   * that order, so deleting it here destroys the only record of it that will
   * ever exist.
   */
  it("keeps a draft whose confirm throws, and names it rather than deleting it", async () => {
    const { company, warehouse } = await setup();
    // Built directly, as the other bundle tests here do: makeProduct has no
    // isBundle override and would silently return an ordinary product, which
    // confirmSale would book happily — leaving this test asserting nothing.
    const kit = await prisma.product.create({
      data: {
        companyId: company.id, nameAr: "باقة المطبخ", nameEn: "Kitchen kit",
        sku: "kitchen-kit-111", isBundle: true, trackInventory: false,
      },
    });
    expect(kit.isBundle).toBe(true);

    mockPages([{
      list: listRow("SO-9", "new_order"),
      detail: {
        order_id: "SO-9", omniful_order_id: "omn-SO-9", status_code: "new_order",
        order_items: [{ sku_code: "kitchen-kit-111", quantity: 2, unit_price: 259 }],
      },
    }]);
    await syncFastHubOrders(company.id, warehouse.id);
    expect(await prisma.salesOrder.count()).toBe(1);

    // Now it ships — but the bundle still has no recipe, so confirm throws.
    vi.restoreAllMocks();
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input) => {
      if (String(input).includes("/v2/seller/orders")) {
        return jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: "cur-end" } });
      }
      return jsonResponse({
        data: {
          order_id: "SO-9", omniful_order_id: "omn-SO-9", status_code: "delivered",
          order_items: [{ sku_code: "kitchen-kit-111", quantity: 2, unit_price: 259 }],
        },
      });
    });

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.failed).toContain("SO-9");
    expect(report.draftsConfirmed).toBe(0);
    expect(await prisma.salesOrder.count()).toBe(1);
    expect((await prisma.salesOrder.findFirstOrThrow()).status).toBe("DRAFT");
  });

  it("names a draft it cannot re-read, instead of leaving it silently stuck", async () => {
    const { company, warehouse } = await setup();
    mockPages([{
      list: listRow("SO-2", "new_order"),
      detail: {
        order_id: "SO-2", omniful_order_id: "omn-SO-2", status_code: "new_order",
        order_items: [{ sku_code: "waves-light-004", quantity: 3, unit_price: 260 }],
      },
    }]);
    await syncFastHubOrders(company.id, warehouse.id);

    // Exactly production's SO-0001: imported before the column existed, so
    // there is no id to re-read it with.
    await prisma.salesOrder.updateMany({ data: { omnifulOrderId: null } });

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.draftsUnreadable).toHaveLength(1);
    expect(report.draftsConfirmed).toBe(0);
  });

  it("skips an order with an unknown SKU and names it, rather than guessing a product", async () => {
    const { company, warehouse } = await setup();
    mockPages([{
      list: listRow("SO-3"),
      detail: {
        order_id: "SO-3", omniful_order_id: "omn-SO-3", status_code: "delivered",
        order_items: [{ sku_code: "not-our-sku", quantity: 1, unit_price: 99 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.created).toBe(0);
    expect(report.unknownSkus).toEqual(["not-our-sku"]);
    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("records the components Fast Hub actually picked for a bundle line", async () => {
    // Four of the five bundles are customer-configured, so no stored recipe
    // can know which colours were picked. When Fast Hub names the components,
    // they are the truth and must be recorded against the line.
    const { company, warehouse, ctx, mat } = await setup();
    const gift = await makeProduct(company.id, "caddy-short-013");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: gift.id,
      quantity: toQty(10), unitCost: toCost(toMinor(8)),
    });
    const bundle = await prisma.product.create({
      data: {
        companyId: company.id, nameAr: "باقة", nameEn: "Kit",
        sku: "bath-kit-111", isBundle: true, trackInventory: false,
      },
    });
    await setBundleRecipe(ctx, {
      bundleProductId: bundle.id,
      components: [{ productId: mat.id, quantity: toQty(1) }],
    });
    mockPages([{
      list: listRow("SO-4"),
      detail: {
        order_id: "SO-4", omniful_order_id: "omn-SO-4", status_code: "delivered",
        order_items: [
          { sku_code: "bath-kit-111", quantity: 1, unit_price: 239 },
          { sku_code: "waves-light-004", quantity: 1, unit_price: 0, is_bundle_component: true, parent_sku_code: "bath-kit-111" },
          { sku_code: "caddy-short-013", quantity: 1, unit_price: 0, is_bundle_component: true, parent_sku_code: "bath-kit-111" },
        ],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.created).toBe(1);
    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { productId: bundle.id } });
    const components = await prisma.salesOrderItemComponent.findMany({
      where: { salesOrderItemId: item.id },
    });
    expect(components).toHaveLength(2);
    expect(new Set(components.map((c) => c.componentProductId)))
      .toEqual(new Set([mat.id, gift.id]));
    // The picked gift moved, not just the recipe's single mat.
    const giftBalance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: gift.id } });
    expect(giftBalance.availableQty).toBe(toQty(9));
  });

  it("stores the resume cursor only after the page is processed", async () => {
    const { company, warehouse } = await setup();
    mockPages([{
      list: listRow("SO-5"),
      detail: {
        order_id: "SO-5", omniful_order_id: "omn-SO-5", status_code: "delivered",
        order_items: [{ sku_code: "waves-light-004", quantity: 1, unit_price: 260 }],
      },
    }]);

    await syncFastHubOrders(company.id, warehouse.id);

    const row = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId: company.id } });
    expect(row.ordersCursor).toBe("cur-end");
  });

  it("does not advance the cursor when a page throws", async () => {
    const { company, warehouse } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/v2/seller/orders")) {
        return jsonResponse({
          data: [listRow("SO-6")],
          meta: { has_next_page: false, end_cursor: "cur-end" },
        });
      }
      // The detail fetch fails: the page cannot be processed, so re-polling
      // must see this order again rather than skipping past it forever.
      return jsonResponse({ message: "boom" }, 500);
    });

    await expect(syncFastHubOrders(company.id, warehouse.id)).rejects.toThrow();

    const row = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId: company.id } });
    expect(row.ordersCursor).toBeNull();
  });

  it("skips a cancelled order without creating anything", async () => {
    const { company, warehouse } = await setup();
    mockPages([{
      list: listRow("SO-7", "cancelled"),
      detail: {
        order_id: "SO-7", omniful_order_id: "omn-SO-7", status_code: "cancelled",
        order_items: [{ sku_code: "waves-light-004", quantity: 1, unit_price: 260 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.created).toBe(0);
    expect(report.skipped).toBe(1);
    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("syncFastHubOrders and the opening balance", () => {
  beforeEach(resetDb);

  /**
   * The opening balances came from Fast Hub's own counts, which are taken
   * AFTER every shipment they have already made. An order that left the
   * warehouse before that count is therefore already reflected in it, and
   * importing it deducts the same units a second time — which is exactly what
   * happened in production on 2026-08-04: 29 units across 8 SKUs vanished
   * from the books while sitting on the shelf.
   */
  it("skips an order that predates the product's opening balance, and names it", async () => {
    const { company, warehouse, ctx } = await setup();
    const mat = await makeProduct(company.id, "rainy-dark-001");
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "rainy-dark-001", available: toQty(20), damaged: 0 }],
    });
    mockPages([{
      list: { ...listRow("SO-OLD"), order_created_at: "2026-05-10T09:00:00Z" },
      detail: {
        order_id: "SO-OLD", omniful_order_id: "omn-SO-OLD", status_code: "delivered",
        order_items: [{ sku_code: "rainy-dark-001", quantity: 3, unit_price: 260 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.created).toBe(0);
    expect(report.preOpening).toEqual(["SO-OLD"]);
    expect(await prisma.salesOrder.count()).toBe(0);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(20));
  });

  /**
   * The guard reads the SKUs in Fast Hub's payload. For a recipe-based bundle
   * that is the bundle SKU ALONE — which holds no stock and therefore has no
   * opening date — so the guard saw nothing to compare and let the order
   * through, depleting components whose units the opening count already
   * excluded. Found on 2026-08-06 while investigating SO-0001, which the guard
   * would not have caught either. Ten of the 24 missing orders are bundles.
   */
  it("skips a BUNDLE order that predates its components' opening balance", async () => {
    const { company, warehouse, ctx } = await setup();
    const bowl = await makeProduct(company.id, "bowl-large-016");
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "bowl-large-016", available: toQty(50), damaged: 0 }],
    });
    const bundle = await prisma.product.create({
      data: {
        companyId: company.id, nameAr: "باقة المطبخ", nameEn: "Kitchen kit",
        sku: "kitchen-kit-111", isBundle: true, trackInventory: false,
      },
    });
    await setBundleRecipe(ctx, {
      bundleProductId: bundle.id,
      components: [{ productId: bowl.id, quantity: toQty(1) }],
    });

    mockPages([{
      list: { ...listRow("SO-KIT"), order_created_at: "2026-05-10T09:00:00Z" },
      detail: {
        order_id: "SO-KIT", omniful_order_id: "omn-SO-KIT", status_code: "delivered",
        order_items: [{ sku_code: "kitchen-kit-111", quantity: 2, unit_price: 259 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.preOpening).toEqual(["SO-KIT"]);
    expect(await prisma.salesOrder.count()).toBe(0);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: bowl.id } });
    expect(balance.availableQty).toBe(toQty(50));
  });

  /**
   * The revisit had no pre-opening guard at all — it checked only whether the
   * order had shipped. New drafts are covered because the guard runs at import,
   * but a draft created BEFORE its product's opening balance existed passes
   * underneath it. That is SO-0001's exact history, and there the stock floor
   * refused the deduction by luck rather than by design.
   */
  it("refuses to confirm a draft whose goods left before the opening balance", async () => {
    const { company, warehouse, ctx } = await setup();
    await makeProduct(company.id, "bowl-small-017");

    mockPages([{
      list: { ...listRow("SO-PRE", "new_order"), order_created_at: "2026-05-10T09:00:00Z" },
      detail: {
        order_id: "SO-PRE", omniful_order_id: "omn-SO-PRE", status_code: "new_order",
        order_items: [{ sku_code: "bowl-small-017", quantity: 2, unit_price: 30 }],
      },
    }]);
    await syncFastHubOrders(company.id, warehouse.id);
    expect((await prisma.salesOrder.findFirstOrThrow()).status).toBe("DRAFT");

    // The opening count arrives afterwards, exactly as it did in production:
    // the draft was already on the books when the balance was declared.
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "bowl-small-017", available: toQty(40), damaged: 0 }],
    });

    // Now it ships. The stream offers nothing new — only the revisit can reach it.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/v2/seller/orders")) {
        return jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: "cur-end" } });
      }
      return jsonResponse({
        data: {
          order_id: "SO-PRE", omniful_order_id: "omn-SO-PRE", status_code: "delivered",
          order_items: [{ sku_code: "bowl-small-017", quantity: 2, unit_price: 30 }],
        },
      });
    });

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.draftsConfirmed).toBe(0);
    expect(report.preOpening).toContain("SO-PRE");
    expect((await prisma.salesOrder.findFirstOrThrow()).status).toBe("DRAFT");
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { product: { sku: "bowl-small-017" } },
    });
    expect(balance.availableQty).toBe(toQty(40));
  });

  it("still imports an order placed after the opening balance", async () => {
    // The other half of the guard. Without this, "block everything that has an
    // opening balance" would pass the test above and silently stop the sync.
    const { company, warehouse, ctx } = await setup();
    const mat = await makeProduct(company.id, "rainy-dark-001");
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "rainy-dark-001", available: toQty(20), damaged: 0 }],
    });
    mockPages([{
      list: {
        ...listRow("SO-NEW"),
        order_created_at: new Date(Date.now() + 60_000).toISOString(),
      },
      detail: {
        order_id: "SO-NEW", omniful_order_id: "omn-SO-NEW", status_code: "delivered",
        order_items: [{ sku_code: "rainy-dark-001", quantity: 3, unit_price: 260 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.preOpening).toEqual([]);
    expect(report.created).toBe(1);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: mat.id } });
    expect(balance.availableQty).toBe(toQty(17));
  });

  it("skips an order carrying no creation date once a product has an opening balance", async () => {
    // Undatable against the boundary. Guessing it is safe would deduct stock
    // that may already be gone — the failure this whole guard exists to stop.
    const { company, warehouse, ctx } = await setup();
    await makeProduct(company.id, "rainy-dark-001");
    await importFastHubOpeningStock(ctx, {
      warehouseId: warehouse.id,
      counts: [{ sku: "rainy-dark-001", available: toQty(20), damaged: 0 }],
    });
    mockPages([{
      list: { ...listRow("SO-NODATE"), order_created_at: undefined },
      detail: {
        order_id: "SO-NODATE", omniful_order_id: "omn-SO-NODATE", status_code: "delivered",
        order_items: [{ sku_code: "rainy-dark-001", quantity: 1, unit_price: 260 }],
      },
    }]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    expect(report.preOpening).toEqual(["SO-NODATE"]);
    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("syncFastHubOrders resilience", () => {
  beforeEach(resetDb);

  it("skips an order it cannot import and keeps going, instead of losing the page", async () => {
    // A REAL order from Fast Hub names `kitchen-kit-111` — the bundle itself,
    // not its components — and that bundle has no stored recipe, so expanding
    // it throws. Letting the throw escape aborted the whole poll: every later
    // order on the page went unimported and the cursor did not advance, so the
    // same failure repeated forever and no order could ever arrive.
    const { company, warehouse, ctx } = await setup();
    const good = await makeProduct(company.id, "caddy-long-012");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: good.id,
      quantity: toQty(10), unitCost: toCost(toMinor(5)),
    });
    const bundle = await prisma.product.create({
      data: {
        companyId: company.id, nameAr: "باقة", nameEn: "Kit",
        sku: "kitchen-kit-111", isBundle: true, trackInventory: false,
      },
    });

    mockPages([
      {
        list: listRow("SO-BAD"),
        detail: {
          order_id: "SO-BAD", omniful_order_id: "omn-SO-BAD", status_code: "delivered",
          order_items: [{ sku_code: "kitchen-kit-111", quantity: 1, unit_price: 259, total: 259 }],
        },
      },
      {
        list: listRow("SO-GOOD"),
        detail: {
          order_id: "SO-GOOD", omniful_order_id: "omn-SO-GOOD", status_code: "delivered",
          order_items: [{ sku_code: "caddy-long-012", quantity: 2, unit_price: 28, total: 56 }],
        },
      },
    ]);

    const report = await syncFastHubOrders(company.id, warehouse.id);

    // The good order landed despite the bad one preceding it.
    expect(report.created).toBe(1);
    expect(report.failed).toEqual(["SO-BAD"]);

    const orders = await prisma.salesOrder.findMany({ select: { externalRef: true } });
    expect(orders.map((o) => o.externalRef)).toEqual(["SO-GOOD"]);
    // Nothing half-written for the failed one.
    expect(await prisma.product.findUniqueOrThrow({ where: { id: bundle.id } })).toBeTruthy();

    // The cursor still advances: the page was fully processed, and a failure
    // that repeats every poll must not pin the sync to the same page forever.
    const row = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId: company.id } });
    expect(row.ordersCursor).toBe("cur-end");
  });
});

/**
 * The channel this poller stamps is not in `SALES_CHANNELS` — that constant
 * lists what a human may PICK on the sale form, and nobody picks Fast Hub by
 * hand. But the sales list renders every row's channel through
 * `t("sales.channelOptions.<channel>")`, and this dictionary has no entry for
 * the one value the poller writes, so every order on the busiest list screen
 * read `sales.channelOptions.FASTHUB` in production. The translator returns
 * the key when a lookup misses, by design, so the gap was visible rather than
 * blank — and stayed visible for a month.
 */
describe("the channel the poller stamps", () => {
  it("has a label in both dictionaries", async () => {
    const { getTranslator } = await import("@/lib/i18n");

    for (const locale of ["ar", "en"] as const) {
      const t = await getTranslator(locale);
      const label = t("sales.channelOptions.FASTHUB");
      expect(label).not.toBe("sales.channelOptions.FASTHUB");
      expect(label.trim()).not.toBe("");
    }
  });
});

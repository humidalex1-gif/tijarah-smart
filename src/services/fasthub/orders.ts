import { prisma } from "@/lib/db";
import { ServiceError } from "@/services/errors";
import { toQty, toMinor } from "@/lib/money";
import { createSalesOrder, confirmSale } from "@/services/sales";
import { paginateOrders, fetchOrderById, type OmnifulOrder, type OmnifulOrderItem } from "@/services/fasthub/api";

/**
 * The orders poller: Fast Hub's order stream becomes sales orders here.
 *
 * Three rules shape it, each learned the hard way elsewhere in this codebase:
 *
 * 1. **Stock moves only when goods leave.** An order that has not shipped is
 *    recorded as a DRAFT. Confirming on `new_order` would deplete the shelf
 *    for goods still sitting on it, and the next reconciliation would report
 *    a phantom shortfall.
 * 2. **Nothing is guessed.** An order naming a SKU we do not stock is skipped
 *    whole and NAMED in the report. Inventing a product, or importing the
 *    order without that line, would silently corrupt both stock and revenue.
 * 3. **The cursor advances only after the page is fully processed.** Storing
 *    it on fetch would skip forever any page whose processing threw.
 * 4. **Nothing older than the opening balance may move stock.** Fast Hub's
 *    counts are taken after every shipment they have already made, so an order
 *    that left before the count is baked into it; importing it deducts the
 *    same units twice. Production lost 29 units across 8 SKUs to exactly this
 *    on 2026-08-04. Such an order is skipped whole and NAMED — a false skip is
 *    loud and recoverable, a false deduction is silent and corrupts the shelf.
 */

/** Fast Hub statuses at which the goods have left the warehouse. */
const SHIPPED_STATUSES = new Set([
  "shipped", "delivered", "out_for_delivery", "in_transit", "consolidated",
]);

/** Statuses that will never move goods, so they are recorded as nothing. */
const DEAD_STATUSES = new Set(["cancelled", "rejected", "failed"]);

export type OrderSyncReport = {
  created: number;
  /** Orders already imported by an earlier poll. */
  alreadySeen: number;
  /** Cancelled and the like: nothing to record. */
  skipped: number;
  /** SKUs named by an order that match no product. The order is NOT imported. */
  unknownSkus: string[];
  /**
   * Orders older than the opening balance of a product they name, by their
   * Fast Hub number. Their goods left before the count that seeded the books,
   * so importing them would deduct the same units twice. Named rather than
   * counted: if one of these is genuinely missing from the books, only the
   * merchant can say so — and the remedy is to re-date the opening balance,
   * not to import the order.
   */
  preOpening: string[];
  /**
   * Orders that threw and were left unimported, by their Fast Hub number.
   * Named rather than counted: the merchant has to go and look at these, and
   * a bare count tells them nothing about which.
   */
  failed: string[];
  /** Drafts from an earlier poll that have since shipped and are now booked. */
  draftsConfirmed: number;
  /** Drafts re-read and still not shipped. Normal, and worth seeing. */
  draftsPending: number;
  /**
   * Drafts that CANNOT be re-read, by order number: imported before
   * `omnifulOrderId` was stored, so there is no identifier their detail
   * endpoint accepts. Named, because each one is an order the books will
   * never finish on their own. Production's SO-0001 is the reason this exists.
   */
  draftsUnreadable: string[];
  /** Confirmed in the books, then cancelled at Fast Hub — the owner must decide. */
  cancelledAfterConfirm: string[];
};

/**
 * A line Fast Hub reports as part of a bundle rather than as its own sale.
 * The dashboard's own payloads have not been seen for a real bundle order yet
 * (spec §8.1), so BOTH documented shapes are accepted: an explicit
 * `parent_sku_code`, or a flag with the bundle immediately preceding it.
 */
function isComponentLine(item: OmnifulOrderItem & { is_bundle_component?: boolean; parent_sku_code?: string }) {
  return Boolean(item.parent_sku_code) || item.is_bundle_component === true;
}

export async function syncFastHubOrders(
  companyId: string,
  warehouseId: string,
): Promise<OrderSyncReport> {
  const connection = await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId } });
  const report: OrderSyncReport = {
    created: 0, alreadySeen: 0, skipped: 0, unknownSkus: [], preOpening: [], failed: [],
    draftsConfirmed: 0, draftsPending: 0, draftsUnreadable: [], cancelledAfterConfirm: [],
  };
  const openingDates = await openingBalanceDates(companyId, warehouseId);

  const cursor = await paginateOrders(companyId, connection.ordersCursor, async (page) => {
    for (const summary of page) {
      // Per ORDER, not per page. A real order naming a bundle SKU with no
      // stored recipe throws, and letting that escape aborted the entire poll:
      // every later order went unimported, the cursor never advanced, and the
      // same page failed again on every run — the sync could never make
      // progress past one bad order. Each import is now its own blast radius.
      try {
        await importOrder(companyId, warehouseId, summary, report, openingDates);
      } catch (error) {
        // Only DATA failures are absorbed. A transport failure — Fast Hub
        // down, rate-limited, a 500 on the detail fetch — means the page was
        // never really read, so it must propagate and leave the cursor where
        // it is; swallowing it would skip those orders forever. A bundle with
        // no recipe, by contrast, will fail identically on every future poll,
        // so stalling on it pins the sync to one page for good.
        if (error instanceof ServiceError && error.code === "FASTHUB_REQUEST_FAILED") throw error;
        if (error instanceof ServiceError && error.code === "FASTHUB_RATE_LIMITED") throw error;
        report.failed.push(summary.order_id);
        console.error("Fast Hub order import failed:", summary.order_id, error);
      }
    }
  });

  // Only now, with every order on every page committed or deliberately
  // skipped, is it safe to remember where we stopped.
  await prisma.fastHubConnection.update({
    where: { companyId },
    data: { ordersCursor: cursor, lastPolledAt: new Date() },
  });

  // After the cursor is durable, deliberately: the revisit is a second pass
  // over orders the stream has already gone past, so it must not be able to
  // hold the cursor back. If it throws, the walk above still counts.
  await revisitDraftOrders(companyId, report, openingDates);

  return report;
}

/**
 * Re-reads orders left as DRAFTs by an earlier poll, and books the ones that
 * have since shipped.
 *
 * This exists because the poller is a forward-only stream reader and a draft
 * needs a re-read the stream will never offer. TWO mechanisms put it out of
 * reach: `importOrder` matches the `externalKey` and returns `alreadySeen`,
 * and `search_after` only ever moves forward. Production lost SO-0001 to
 * exactly this — 518.00 SAR that moved no stock and appeared in no report.
 *
 * Bounded work: normally there are no drafts at all, and one detail call each
 * when there are.
 */
async function revisitDraftOrders(
  companyId: string,
  report: OrderSyncReport,
  openingDates: Map<string, Date>,
): Promise<void> {
  const drafts = await prisma.salesOrder.findMany({
    where: { companyId, status: "DRAFT", externalSource: "FASTHUB" },
    select: {
      id: true, salesOrderNumber: true, externalRef: true, omnifulOrderId: true,
      orderDate: true, items: { select: { productId: true } },
    },
    orderBy: { orderDate: "asc" },
  });

  for (const draft of drafts) {
    if (!draft.omnifulOrderId) {
      // Imported before the id was stored. Their detail endpoint rejects the
      // merchant-facing number, so this order cannot be asked about at all.
      report.draftsUnreadable.push(draft.salesOrderNumber);
      continue;
    }

    try {
      const detail = await fetchOrderById(companyId, draft.omnifulOrderId);
      if (!SHIPPED_STATUSES.has(detail.status_code)) {
        report.draftsPending += 1;
        continue;
      }

      // The same guard the import path applies, and it was missing here.
      // A draft created BEFORE its products' opening balance existed slips
      // under the import-time check — SO-0001's exact history — and confirming
      // it would deduct units the opening count already excluded. The stock
      // floor happened to refuse that one; it was luck, not design.
      const moving = await stockMovingProductIds(companyId, draft.items.map((i) => i.productId));
      if (predatesOpeningBalance(moving, draft.orderDate, openingDates)) {
        const ref = draft.externalRef ?? draft.salesOrderNumber;
        if (!report.preOpening.includes(ref)) report.preOpening.push(ref);
        continue;
      }

      await confirmSale({ companyId, userId: null }, { salesOrderId: draft.id });
      report.draftsConfirmed += 1;
    } catch (error) {
      // Transport failures mean the order was never really read, so they
      // propagate rather than being recorded as a property of the order.
      if (error instanceof ServiceError && error.code === "FASTHUB_REQUEST_FAILED") throw error;
      if (error instanceof ServiceError && error.code === "FASTHUB_RATE_LIMITED") throw error;
      // The draft is KEPT. importOrder deletes one whose confirm throws so a
      // later poll can re-import it cleanly — right there, fatal here, because
      // the cursor has already passed this order and the draft is the only
      // record of it that will ever exist.
      report.failed.push(draft.externalRef ?? draft.salesOrderNumber);
      console.error("Fast Hub draft revisit failed:", draft.salesOrderNumber, error);
    }
  }
}

/**
 * When each product's books started, per product, read from the ledger rather
 * than from a column: the opening import is the only writer of
 * `FASTHUB_IMPORT` movements, so the earliest one IS the moment that product's
 * balance was declared. Deriving it means a re-dated or corrected opening
 * import moves the boundary with it and cannot drift out of step with the
 * stock it describes.
 *
 * Per product, not per warehouse: products whose opening balance is corrected
 * to an earlier date must accept older orders again, while the rest keep the
 * later boundary they were actually counted at.
 */
async function openingBalanceDates(
  companyId: string,
  warehouseId: string,
): Promise<Map<string, Date>> {
  const rows = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    where: { companyId, warehouseId, referenceType: "FASTHUB_IMPORT" },
    _min: { movementDate: true },
  });
  const dates = new Map<string, Date>();
  for (const row of rows) {
    if (row._min.movementDate) dates.set(row.productId, row._min.movementDate);
  }
  return dates;
}

/**
 * The products whose STOCK an order will move — which is NOT the set of
 * products it names.
 *
 * A recipe-based bundle holds no stock of its own and therefore has no opening
 * balance, so comparing the payload's SKUs alone compares nothing for it: the
 * guard saw a bundle, found no opening date, and let the order through to
 * deplete components whose units the opening count had already excluded. Found
 * on 2026-08-06 investigating SO-0001, which the guard would not have caught.
 *
 * Order-supplied components need no special handling here — Fast Hub sends
 * them as their own lines, so they are already among `productIds`.
 */
async function stockMovingProductIds(
  companyId: string,
  productIds: string[],
): Promise<string[]> {
  if (productIds.length === 0) return [];
  const components = await prisma.bundleComponent.findMany({
    where: { companyId, bundleProductId: { in: productIds } },
    select: { componentProductId: true },
  });
  return [...new Set([...productIds, ...components.map((c) => c.componentProductId)])];
}

/**
 * Whether an order's goods left before the books began, for any product it
 * moves. The opening counts are net of every shipment already made, so such an
 * order is baked into them and importing it deducts the same units twice.
 */
function predatesOpeningBalance(
  productIds: string[],
  orderDate: Date | null,
  openingDates: Map<string, Date>,
): boolean {
  return productIds.some((id) => {
    const opened = openingDates.get(id);
    if (!opened) return false;
    // An order with no date cannot be placed on either side of the boundary,
    // and the safe side of "cannot tell" is the one that moves no stock.
    return orderDate === null || orderDate < opened;
  });
}

async function importOrder(
  companyId: string,
  warehouseId: string,
  summary: OmnifulOrder,
  report: OrderSyncReport,
  openingDates: Map<string, Date>,
): Promise<void> {
  const externalKey = `FASTHUB:${summary.order_id}`;
  const existing = await prisma.salesOrder.findFirst({
    where: { companyId, externalKey },
    select: { id: true, status: true, salesOrderNumber: true },
  });
  if (existing) {
    // A CONFIRMED order the warehouse now reports dead is booked revenue and
    // a stock deduction the books still carry. Reversing money is the owner's
    // decision (cancelSale exists for it) — the sync's whole job here is to
    // refuse to stay silent. Before this check, "alreadySeen" answered first
    // and the cancellation vanished forever.
    if (DEAD_STATUSES.has(summary.status_code) && existing.status === "CONFIRMED"
      && !report.cancelledAfterConfirm.includes(existing.salesOrderNumber)) {
      report.cancelledAfterConfirm.push(existing.salesOrderNumber);
    }
    report.alreadySeen += 1;
    return;
  }

  if (DEAD_STATUSES.has(summary.status_code)) {
    report.skipped += 1;
    return;
  }

  // The V2 list carries no items — by design, since 2025-09-30 — so the
  // detail call is not an optimisation, it is the only source of lines.
  // `omniful_order_id`, NOT `order_id`. The list carries four identifiers and
  // the detail endpoint accepts exactly one of them; the merchant-facing
  // `order_id` and the `order_alias` both come back 400 "Please provide a
  // valid order ID". Verified against the live API 2026-08-04.
  const detailId = summary.omniful_order_id ?? summary.id;
  if (!detailId) {
    // Cannot be fetched, so cannot be imported honestly. Counted, not guessed.
    report.skipped += 1;
    return;
  }
  const detail = await fetchOrderById(companyId, detailId);
  const items = detail.order_items ?? [];
  if (items.length === 0) {
    report.skipped += 1;
    return;
  }

  const skus = [...new Set(items.map((i) => i.sku_code))];
  const products = await prisma.product.findMany({
    where: { companyId, sku: { in: skus } },
    select: { id: true, sku: true, isBundle: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p]));

  const missing = skus.filter((sku) => !bySku.has(sku));
  if (missing.length > 0) {
    // Whole-order skip: importing the lines we recognise would book revenue
    // for a part of an order and leave the rest invisible forever.
    for (const sku of missing) {
      if (!report.unknownSkus.includes(sku)) report.unknownSkus.push(sku);
    }
    return;
  }

  // Every stock-moving product is checked, not just the sold lines: a bundle's
  // components move stock too, so a component whose balance predates the order
  // is the same double deduction wearing a different hat. Recipe components are
  // resolved here because the payload never names them.
  const orderDate = summary.order_created_at ? new Date(summary.order_created_at) : null;
  const moving = await stockMovingProductIds(companyId, [...bySku.values()].map((p) => p.id));
  if (predatesOpeningBalance(moving, orderDate, openingDates)) {
    if (!report.preOpening.includes(summary.order_id)) report.preOpening.push(summary.order_id);
    return;
  }

  // Split the flat line list into sold lines and the components that belong
  // to them. A component line is not a sale of its own — it says WHAT was
  // picked for the bundle above it.
  const sold: OmnifulOrderItem[] = [];
  const componentsFor = new Map<string, OmnifulOrderItem[]>();
  let lastBundleSku: string | null = null;
  for (const item of items) {
    const flagged = item as OmnifulOrderItem & { parent_sku_code?: string };
    if (isComponentLine(flagged)) {
      const parent = flagged.parent_sku_code ?? lastBundleSku;
      if (parent) {
        const list = componentsFor.get(parent) ?? [];
        list.push(item);
        componentsFor.set(parent, list);
        continue;
      }
    }
    sold.push(item);
    if (bySku.get(item.sku_code)?.isBundle) lastBundleSku = item.sku_code;
  }

  const { salesOrderId } = await createSalesOrder({ companyId, userId: null }, {
    warehouseId,
    channel: "FASTHUB",
    orderDate: summary.order_created_at ? new Date(summary.order_created_at) : undefined,
    shippingCharged: toMinor(detail.invoice?.shipping_price ?? 0),
    items: sold.map((item) => ({
      productId: bySku.get(item.sku_code)!.id,
      quantity: toQty(item.quantity),
      unitPrice: toMinor(item.unit_price ?? 0),
      discountAmount: toMinor(item.discount ?? 0),
      // Prices in the payload are gross of the invoice's own tax figure; the
      // per-line rate is carried when Fast Hub states one.
      taxRatePct: item.tax && item.unit_price ? undefined : 0,
    })),
  });

  await prisma.salesOrder.update({
    where: { id: salesOrderId },
    data: {
      externalSource: "FASTHUB", externalRef: summary.order_id, externalKey,
      // The only identifier that can fetch this order again. Stored even for
      // orders confirmed on this pass: today's shipped order is tomorrow's
      // return, and a draft is not the only reason to re-read one.
      omnifulOrderId: detailId,
    },
  });

  // Record what was actually picked, per line, before confirming: confirmSale
  // reads these and prefers them over any stored recipe.
  if (componentsFor.size > 0) {
    const orderItems = await prisma.salesOrderItem.findMany({
      where: { salesOrderId },
      select: { id: true, productId: true },
    });
    const itemByProduct = new Map(orderItems.map((i) => [i.productId, i.id]));
    for (const [bundleSku, components] of componentsFor) {
      const bundleProductId = bySku.get(bundleSku)?.id;
      const salesOrderItemId = bundleProductId ? itemByProduct.get(bundleProductId) : undefined;
      if (!salesOrderItemId) continue;
      for (const component of components) {
        await prisma.salesOrderItemComponent.create({
          data: {
            companyId,
            salesOrderItemId,
            componentProductId: bySku.get(component.sku_code)!.id,
            quantity: toQty(component.quantity),
          },
        });
      }
    }
  }

  if (SHIPPED_STATUSES.has(summary.status_code)) {
    try {
      await confirmSale({ companyId, userId: null }, { salesOrderId });
    } catch (error) {
      // createSalesOrder and confirmSale are separate transactions, so a
      // confirm that throws — a bundle with no recipe is the real case —
      // leaves a DRAFT behind carrying the externalKey. The next poll would
      // then see the key, call it already-imported, and never retry: an order
      // stuck as a draft forever, moving no stock and reported nowhere.
      //
      // confirmSale is itself transactional, so on a throw nothing of it
      // committed and the order is still an untouched draft: deleting it
      // leaves no movement, no ledger entry and no trace, and lets a later
      // poll import it properly once the recipe exists.
      await prisma.salesOrder.delete({ where: { id: salesOrderId } });
      throw error;
    }
  }

  report.created += 1;
}

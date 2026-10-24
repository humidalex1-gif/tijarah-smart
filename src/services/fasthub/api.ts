import { fastHubGet, fastHubPaginate } from "@/services/fasthub/client";

/**
 * The typed endpoint layer over the raw Fast Hub (Omniful) client.
 *
 * Paths were verified against the published Postman collection on 2026-08-04
 * (design spec §9), not recalled. Two of them are deliberately "mismatched"
 * versions: order LISTS come from V2 because the V1 list is deprecated
 * (2026-07-30) and already lost its order_items — while order DETAILS come
 * from the V1 by-id endpoint, which is the only place the items still live.
 */

export const FASTHUB_PATHS = {
  orders: "/sales-channel/public/v2/seller/orders",
  orderById: (orderId: string) => `/sales-channel/public/v1/seller/orders/${encodeURIComponent(orderId)}`,
  returnOrders: "/sales-channel/public/v2/seller/return_orders",
  returnOrderById: (returnOrderId: string) => `/sales-channel/public/v1/return_orders/${encodeURIComponent(returnOrderId)}`,
  hubInventory: (hubCode: string) => `/sales-channel/public/v1/seller/inventory/hubs/${encodeURIComponent(hubCode)}`,
} as const;

/** One row of `GET .../inventory/hubs/:hub_code`. Quantities are plain units. */
export type OmnifulInventoryRow = {
  hub_code: string;
  sku_code: string;
  sku_name: string;
  available_quantity: number;
  quantity_on_hand: number;
  quantity_reserved: number;
  uom: string;
};

/** One order line, present only on the V1 by-id endpoint. */
export type OmnifulOrderItem = {
  sku_code: string;
  quantity: number;
  picked_quantity?: number;
  packed_quantity?: number;
  unit_price?: number;
  tax?: number;
  discount?: number;
  total?: number;
  item_barcodes?: string[];
};

/** An order as the V2 list returns it (no items) or V1 by-id (with items). */
export type OmnifulOrder = {
  id?: string;
  /**
   * The merchant-facing order number. Good for display and for the idempotency
   * key — and REJECTED by the detail endpoint, which wants the id below.
   */
  order_id: string;
  /** The only identifier `GET /v1/seller/orders/:id` accepts. */
  omniful_order_id?: string;
  /** Salla's own order number, carried through. Not accepted by the API either. */
  order_alias?: string;
  status_code: string;
  display_status?: string;
  hub_code?: string;
  order_created_at?: string;
  updated_at?: string;
  invoice?: {
    currency?: string;
    subtotal?: number;
    shipping_price?: number;
    tax?: number;
    discount?: number;
    total?: number;
  };
  order_items?: OmnifulOrderItem[];
};

/** One per-SKU line of a return, present only on the V1 by-id endpoint. */
export type OmnifulReturnItem = {
  sku_code: string;
  return_quantity: number;
  delivered_quantity?: number;
};

export type OmnifulReturnOrder = {
  id?: string;
  return_order_id: string;
  order_id: string;
  /** e.g. "Customer Return" */
  type?: string;
  /** Display status, e.g. "Return Shipment Created". */
  status?: string;
  /** "Pending" until the warehouse runs QC — the sellable/damaged moment. */
  oms_qc_status?: string;
  qc_fail_reasons?: { key: string; display_name: string }[];
  total_return_quantity?: number;
  returned_quantity?: number;
  created_at?: string;
  updated_at?: string;
  items?: OmnifulReturnItem[];
};

type Envelope<T> = { is_success?: boolean; data?: T };
type PageMeta = { current_page?: number; last_page?: number };

/**
 * The hub inventory endpoint is V1 and paginates by page NUMBER when it
 * paginates at all (the docs' example carries no pagination). Both shapes are
 * handled: a flat body returns after one call; a page-numbered body is walked
 * until `last_page`.
 */
export async function fetchHubInventory(
  companyId: string,
  hubCode: string,
  window?: { updatedFrom: string; updatedTo: string },
): Promise<OmnifulInventoryRow[]> {
  const params: Record<string, string> = window
    ? { updated_from: window.updatedFrom, updated_to: window.updatedTo, timezone: "UTC" }
    : {};

  const rows: OmnifulInventoryRow[] = [];
  let page = 1;
  for (;;) {
    const body = await fastHubGet<Envelope<OmnifulInventoryRow[]> & { meta?: PageMeta }>(
      companyId,
      FASTHUB_PATHS.hubInventory(hubCode),
      { ...params, ...(page > 1 ? { page: String(page) } : {}) },
    );
    rows.push(...(body.data ?? []));
    const meta = body.meta;
    if (!meta?.last_page || !meta.current_page || meta.current_page >= meta.last_page) return rows;
    page = meta.current_page + 1;
  }
}

export async function fetchOrderById(companyId: string, orderId: string): Promise<OmnifulOrder> {
  const body = await fastHubGet<Envelope<OmnifulOrder>>(companyId, FASTHUB_PATHS.orderById(orderId));
  return body.data ?? (body as unknown as OmnifulOrder);
}

export async function fetchReturnOrderById(
  companyId: string,
  returnOrderId: string,
): Promise<OmnifulReturnOrder> {
  const body = await fastHubGet<Envelope<OmnifulReturnOrder>>(
    companyId,
    FASTHUB_PATHS.returnOrderById(returnOrderId),
  );
  return body.data ?? (body as unknown as OmnifulReturnOrder);
}

/** Cursor-walks the V2 order list. Returns the cursor to store AFTER processing. */
export function paginateOrders(
  companyId: string,
  cursor: string | null,
  onPage: (page: OmnifulOrder[]) => Promise<void>,
): Promise<string | null> {
  return fastHubPaginate<OmnifulOrder>(companyId, FASTHUB_PATHS.orders, { cursor }, onPage);
}

/** Cursor-walks the V2 return-order list. Returns the cursor to store AFTER processing. */
export function paginateReturnOrders(
  companyId: string,
  cursor: string | null,
  onPage: (page: OmnifulReturnOrder[]) => Promise<void>,
): Promise<string | null> {
  return fastHubPaginate<OmnifulReturnOrder>(companyId, FASTHUB_PATHS.returnOrders, { cursor }, onPage);
}

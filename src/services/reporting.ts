import { prisma } from "@/lib/db";
import { costOf, unitCostFrom } from "@/lib/money";

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Confirmed and completed orders count toward performance; cancelled ones
 * never do. This is why: cancelSale never resets paymentStatus (there's no
 * REFUNDED value to move it to), so a cancelled order that was paid in full
 * still reads paymentStatus === "PAID". Any report or receivables query MUST
 * filter status != "CANCELLED" before trusting paymentStatus — see
 * docs/decisions.md.
 */
export const LIVE_ORDER_STATUSES = ["CONFIRMED", "COMPLETED"];

/**
 * A DateRange is interpreted at UTC-day granularity: both endpoint days are
 * fully included regardless of the time-of-day the caller passed. Filtering on
 * the raw bounds would silently drop same-day orders whose timestamp is later
 * than `to`, while still emitting a bucket for that day.
 */
function dayWindow(range: DateRange) {
  return {
    gte: new Date(Date.UTC(
      range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate(),
    )),
    lt: new Date(Date.UTC(
      range.to.getUTCFullYear(), range.to.getUTCMonth(), range.to.getUTCDate() + 1,
    )),
  };
}

export async function salesSummary(companyId: string, range: DateRange) {
  const orders = await prisma.salesOrder.findMany({
    where: {
      companyId,
      status: { in: LIVE_ORDER_STATUSES },
      orderDate: dayWindow(range),
    },
    select: {
      subtotal: true, shippingCharged: true, refundedAmount: true,
      grossProfit: true, netProfit: true,
    },
  });

  return {
    orderCount: orders.length,
    // Net of returns, to match grossProfit/netProfit which processReturn already
    // recomputes net — otherwise revenue and profit imply a nonsensical COGS.
    revenue: orders.reduce((s, o) => s + o.subtotal + o.shippingCharged - o.refundedAmount, 0),
    grossProfit: orders.reduce((s, o) => s + o.grossProfit, 0),
    netProfit: orders.reduce((s, o) => s + o.netProfit, 0),
  };
}

export async function expenseTotal(companyId: string, range: DateRange) {
  const expenses = await prisma.expense.findMany({
    where: {
      companyId,
      status: "CONFIRMED",
      expenseDate: dayWindow(range),
    },
    select: { totalAmount: true },
  });
  return expenses.reduce((s, e) => s + e.totalAmount, 0);
}

export async function inventoryValue(companyId: string) {
  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId },
    select: { availableQty: true, avgCost: true },
  });

  return {
    totalUnits: balances.reduce((s, b) => s + b.availableQty, 0),
    // Always derived, never stored — so it cannot drift from the balances.
    totalValue: balances.reduce((s, b) => s + costOf(b.availableQty, b.avgCost), 0),
  };
}

export async function cashPosition(companyId: string) {
  const accounts = await prisma.financialAccount.findMany({
    where: { companyId, status: "ACTIVE" },
    select: { accountType: true, currentBalance: true },
  });

  const cash = accounts
    .filter((a) => a.accountType === "CASH")
    .reduce((s, a) => s + a.currentBalance, 0);
  const bank = accounts
    .filter((a) => a.accountType === "BANK")
    .reduce((s, a) => s + a.currentBalance, 0);

  return { cash, bank, total: cash + bank };
}

/** Sum of positive customer balances — money owed to the company. */
export async function receivables(companyId: string) {
  // Aggregate rather than read the "latest" row: ledger rows written inside one
  // transaction share a `createdAt`, so ordering by it has no deterministic
  // winner. Customers with no ledger rows contribute 0 and can be omitted.
  const grouped = await prisma.customerLedgerEntry.groupBy({
    by: ["customerId"],
    where: { companyId },
    _sum: { debitAmount: true, creditAmount: true },
  });

  let total = 0;
  for (const row of grouped) {
    const balance = (row._sum.debitAmount ?? 0) - (row._sum.creditAmount ?? 0);
    if (balance > 0) total += balance;
  }
  return total;
}

/** Sum of positive supplier balances — money the company owes. */
export async function payables(companyId: string) {
  const grouped = await prisma.supplierLedgerEntry.groupBy({
    by: ["supplierId"],
    where: { companyId },
    _sum: { creditAmount: true, debitAmount: true },
  });

  let total = 0;
  for (const row of grouped) {
    const balance = (row._sum.creditAmount ?? 0) - (row._sum.debitAmount ?? 0);
    if (balance > 0) total += balance;
  }
  return total;
}

/**
 * Per-supplier balance for the whole company, one query rather than the
 * suppliers LIST page fanning out `supplierBalance` (which takes a `Tx` and
 * answers for one supplier at a time) once per row. Same `groupBy` shape as
 * `payables` immediately above; unlike `payables` this returns EVERY
 * supplier that has at least one ledger row, not just those with a positive
 * (owed) balance — a supplier paid in full or credited ahead still belongs
 * on the list with its true (zero or negative) balance rather than being
 * silently omitted.
 */
export async function supplierBalances(
  companyId: string,
): Promise<Map<string, number>> {
  const grouped = await prisma.supplierLedgerEntry.groupBy({
    by: ["supplierId"],
    where: { companyId },
    _sum: { creditAmount: true, debitAmount: true },
  });

  const balances = new Map<string, number>();
  for (const row of grouped) {
    balances.set(row.supplierId, (row._sum.creditAmount ?? 0) - (row._sum.debitAmount ?? 0));
  }
  return balances;
}

/**
 * Per-customer balance for the whole company, one query rather than the
 * customers LIST page fanning out `customerBalance` (which takes a `Tx` and
 * answers for one customer at a time) once per row. Same `groupBy` shape as
 * `receivables` immediately above; unlike `receivables` this returns EVERY
 * customer that has at least one ledger row, not just those with a positive
 * (owing) balance — a customer paid in full or credited ahead still belongs
 * on the list with its true (zero or negative) balance rather than being
 * silently omitted. Mirrors `supplierBalances` exactly, on the customer side
 * of the ledger.
 */
export async function customerBalances(
  companyId: string,
): Promise<Map<string, number>> {
  const grouped = await prisma.customerLedgerEntry.groupBy({
    by: ["customerId"],
    where: { companyId },
    _sum: { debitAmount: true, creditAmount: true },
  });

  const balances = new Map<string, number>();
  for (const row of grouped) {
    balances.set(row.customerId, (row._sum.debitAmount ?? 0) - (row._sum.creditAmount ?? 0));
  }
  return balances;
}

export async function lowStockProducts(companyId: string, limit = 20) {
  const products = await prisma.product.findMany({
    where: { companyId, status: "ACTIVE", trackInventory: true, reorderLevel: { gt: 0 } },
    select: {
      id: true, nameAr: true, nameEn: true, sku: true, reorderLevel: true,
      balances: { select: { availableQty: true } },
    },
  });

  return products
    .map((p) => ({
      productId: p.id,
      nameAr: p.nameAr,
      nameEn: p.nameEn,
      sku: p.sku,
      availableQty: p.balances.reduce((s, b) => s + b.availableQty, 0),
      reorderLevel: p.reorderLevel,
    }))
    .filter((p) => p.availableQty <= p.reorderLevel)
    .sort((a, b) => a.availableQty - b.availableQty)
    .slice(0, limit);
}

/**
 * Count of ACTIVE, tracked products with zero (or negative) available
 * stock, company-wide. Product-driven, like `lowStockProducts` immediately
 * above — deliberately NOT derived from `balancesForCompany`, which only
 * ever returns rows for a product/warehouse pair that already has an
 * `InventoryBalance` row. A product that has never been received has no
 * such row at all, so it would be silently excluded from a
 * `balancesForCompany`-derived count even though it plainly has zero
 * stock — and the inventory overview page's out-of-stock KPI must agree
 * with its low-stock KPI (which already reads `lowStockProducts` and
 * already includes never-received products) on the same universe, or the
 * two cards can disagree about the very same product.
 */
export async function outOfStockCount(companyId: string): Promise<number> {
  const products = await prisma.product.findMany({
    where: { companyId, status: "ACTIVE", trackInventory: true },
    select: { balances: { select: { availableQty: true } } },
  });
  return products.filter(
    (p) => p.balances.reduce((s, b) => s + b.availableQty, 0) <= 0,
  ).length;
}

export async function bestSellers(companyId: string, range: DateRange, limit = 10) {
  const items = await prisma.salesOrderItem.findMany({
    where: {
      salesOrder: {
        companyId,
        status: { in: LIVE_ORDER_STATUSES },
        orderDate: dayWindow(range),
      },
    },
    select: {
      productId: true, quantity: true, lineTotal: true, totalCost: true,
      returnedQty: true, returnedRevenue: true, returnedCost: true,
      allocatedShipping: true, allocatedPlatformFee: true, allocatedPaymentFee: true,
      allocatedCommission: true, allocatedOtherCost: true,
      product: { select: { nameAr: true, nameEn: true } },
    },
  });

  const byProduct = new Map<string, {
    productId: string; nameAr: string; nameEn: string;
    unitsSold: number; revenue: number; grossProfit: number; netProfit: number;
  }>();

  for (const item of items) {
    const entry = byProduct.get(item.productId) ?? {
      productId: item.productId,
      nameAr: item.product.nameAr,
      nameEn: item.product.nameEn,
      unitsSold: 0, revenue: 0, grossProfit: 0, netProfit: 0,
    };
    // SalesOrderItem.grossProfit/netProfit are posting-time snapshots that
    // processReturn deliberately never revises (lineTotal/totalCost stay gross,
    // with the deltas in returned*). Derive net figures here so this report
    // agrees with the order-level numbers salesSummary reports.
    const netRevenue = item.lineTotal - item.returnedRevenue;
    const netCost = item.totalCost - item.returnedCost;
    const allocated = item.allocatedShipping + item.allocatedPlatformFee
      + item.allocatedPaymentFee + item.allocatedCommission + item.allocatedOtherCost;
    entry.unitsSold += item.quantity - item.returnedQty;
    entry.revenue += netRevenue;
    entry.grossProfit += netRevenue - netCost;
    entry.netProfit += netRevenue - netCost - allocated;
    byProduct.set(item.productId, entry);
  }

  return [...byProduct.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function salesSeries(companyId: string, range: DateRange) {
  const orders = await prisma.salesOrder.findMany({
    where: {
      companyId,
      status: { in: LIVE_ORDER_STATUSES },
      orderDate: dayWindow(range),
    },
    select: {
      orderDate: true, subtotal: true, shippingCharged: true, refundedAmount: true,
      grossProfit: true, netProfit: true,
    },
  });

  const byDay = new Map<string, { revenue: number; grossProfit: number; netProfit: number }>();
  for (const order of orders) {
    const key = dayKey(order.orderDate);
    const entry = byDay.get(key) ?? { revenue: 0, grossProfit: 0, netProfit: 0 };
    entry.revenue += order.subtotal + order.shippingCharged - order.refundedAmount;
    entry.grossProfit += order.grossProfit;
    entry.netProfit += order.netProfit;
    byDay.set(key, entry);
  }

  const series = [];
  const cursor = new Date(Date.UTC(
    range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate(),
  ));
  const end = new Date(Date.UTC(
    range.to.getUTCFullYear(), range.to.getUTCMonth(), range.to.getUTCDate(),
  ));

  while (cursor <= end) {
    const key = dayKey(cursor);
    series.push({ date: key, ...(byDay.get(key) ?? { revenue: 0, grossProfit: 0, netProfit: 0 }) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return series;
}

export interface ProductStock {
  availableQty: number;
  reservedQty: number;
  /** Weighted-average scaled unit cost (COST_SCALE) across every warehouse/variant row. 0 with no stock. */
  avgCost: number;
  /** availableQty valued at avgCost, in minor units. */
  inventoryValue: number;
}

/**
 * Per-product stock summed across every warehouse (and every variant, for a
 * VARIANT product) — the products LIST page's "available stock"/"average
 * cost" columns need one row per product, not per InventoryBalance row.
 * NEVER use `getBalance` for a read like this: it takes a transaction and
 * silently CREATES a zero balance row on a miss, which is wrong for a
 * page-load read.  Batched (one query for every product on the page) rather
 * than N+1 per product row.
 */
export async function productStockSummary(
  companyId: string,
  productIds?: string[],
): Promise<Map<string, ProductStock>> {
  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId, ...(productIds ? { productId: { in: productIds } } : {}) },
    select: { productId: true, availableQty: true, reservedQty: true, avgCost: true },
  });

  const totals = new Map<string, { qty: number; reserved: number; value: number }>();
  for (const balance of balances) {
    const entry = totals.get(balance.productId) ?? { qty: 0, reserved: 0, value: 0 };
    entry.qty += balance.availableQty;
    entry.reserved += balance.reservedQty;
    entry.value += costOf(balance.availableQty, balance.avgCost);
    totals.set(balance.productId, entry);
  }

  const result = new Map<string, ProductStock>();
  for (const [productId, entry] of totals) {
    result.set(productId, {
      availableQty: entry.qty,
      reservedQty: entry.reserved,
      avgCost: entry.qty > 0 ? unitCostFrom(entry.value, entry.qty) : 0,
      inventoryValue: entry.value,
    });
  }
  return result;
}

export type StockStatus = "in" | "low" | "out";

/**
 * Single source of truth for the in/low/out classification — used both to
 * compute each `balancesForCompany` row's own `status` and to implement its
 * `stockStatus` filter, so the badge rendered on screen and the filter that
 * selected the row can never disagree. Mirrors the identically-behaved local
 * `stockKind` helper on the products list page (Stage 1B Task 5) exactly:
 * `reorderLevel` of 0 means "no reorder point set", so such a product can
 * only ever read "out" (at zero) or "in", never "low".
 */
function classifyStock(availableQty: number, reorderLevel: number): StockStatus {
  if (availableQty <= 0) return "out";
  if (reorderLevel > 0 && availableQty <= reorderLevel) return "low";
  return "in";
}

export interface BalanceRow {
  productId: string;
  nameAr: string;
  nameEn: string;
  sku: string;
  categoryId: string | null;
  warehouseId: string;
  warehouseName: string;
  availableQty: number;
  damagedQty: number;
  /** Weighted-average scaled unit cost (COST_SCALE) for this product/warehouse. */
  avgCost: number;
  reorderLevel: number;
  /** availableQty valued at avgCost, in minor units — NEVER damagedQty x avgCost (docs/decisions.md #7). */
  value: number;
  status: StockStatus;
}

/**
 * One row per product/warehouse pair (summed across variants) — the
 * inventory overview page's balances table. Like `productStockSummary`/
 * `productStockDetail`, this reads `InventoryBalance` directly with Prisma
 * (never `getBalance`, which creates a row on a miss) and only ever returns
 * combinations that already have a balance row; nothing is synthesized.
 */
export async function balancesForCompany(
  companyId: string,
  filter?: { warehouseId?: string; productId?: string; categoryId?: string; stockStatus?: StockStatus },
): Promise<BalanceRow[]> {
  const balances = await prisma.inventoryBalance.findMany({
    where: {
      companyId,
      ...(filter?.warehouseId ? { warehouseId: filter.warehouseId } : {}),
      ...(filter?.productId ? { productId: filter.productId } : {}),
      ...(filter?.categoryId ? { product: { categoryId: filter.categoryId } } : {}),
    },
    include: {
      product: {
        select: { nameAr: true, nameEn: true, sku: true, categoryId: true, reorderLevel: true },
      },
      warehouse: { select: { name: true } },
    },
  });

  const grouped = new Map<string, {
    productId: string; nameAr: string; nameEn: string; sku: string; categoryId: string | null;
    warehouseId: string; warehouseName: string;
    availableQty: number; damagedQty: number; value: number; reorderLevel: number;
  }>();

  for (const b of balances) {
    const key = `${b.productId}:${b.warehouseId}`;
    const entry = grouped.get(key) ?? {
      productId: b.productId, nameAr: b.product.nameAr, nameEn: b.product.nameEn, sku: b.product.sku,
      categoryId: b.product.categoryId, warehouseId: b.warehouseId, warehouseName: b.warehouse.name,
      availableQty: 0, damagedQty: 0, value: 0, reorderLevel: b.product.reorderLevel,
    };
    entry.availableQty += b.availableQty;
    entry.damagedQty += b.damagedQty;
    // Damaged stock carries no cost basis (docs/decisions.md #7) — value is
    // derived from availableQty x avgCost only, never damagedQty.
    entry.value += costOf(b.availableQty, b.avgCost);
    grouped.set(key, entry);
  }

  const rows: BalanceRow[] = [...grouped.values()].map((e) => ({
    ...e,
    avgCost: e.availableQty > 0 ? unitCostFrom(e.value, e.availableQty) : 0,
    status: classifyStock(e.availableQty, e.reorderLevel),
  }));

  return filter?.stockStatus ? rows.filter((r) => r.status === filter.stockStatus) : rows;
}

export interface WarehouseSummaryRow {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  city: string | null;
  status: string;
  isDefault: boolean;
  skuCount: number;
  totalUnits: number;
  damagedUnits: number;
  inventoryValue: number;
}

/**
 * Per-warehouse rollup for the warehouses list/detail pages and the
 * inventory overview's summary cards — every warehouse the company has,
 * even one with no stock activity yet (zeroed out, not omitted).
 */
export async function warehouseSummary(companyId: string): Promise<WarehouseSummaryRow[]> {
  const [warehouses, balances] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    prisma.inventoryBalance.findMany({
      where: { companyId },
      select: { warehouseId: true, productId: true, availableQty: true, damagedQty: true, avgCost: true },
    }),
  ]);

  const byWarehouse = new Map<string, {
    skus: Set<string>; units: number; damaged: number; value: number;
  }>();
  for (const b of balances) {
    const entry = byWarehouse.get(b.warehouseId) ?? { skus: new Set<string>(), units: 0, damaged: 0, value: 0 };
    if (b.availableQty > 0 || b.damagedQty > 0) entry.skus.add(b.productId);
    entry.units += b.availableQty;
    entry.damaged += b.damagedQty;
    entry.value += costOf(b.availableQty, b.avgCost);
    byWarehouse.set(b.warehouseId, entry);
  }

  return warehouses.map((w) => {
    const entry = byWarehouse.get(w.id);
    return {
      warehouseId: w.id,
      warehouseName: w.name,
      warehouseCode: w.code,
      city: w.city,
      status: w.status,
      isDefault: w.isDefault,
      skuCount: entry?.skus.size ?? 0,
      totalUnits: entry?.units ?? 0,
      damagedUnits: entry?.damaged ?? 0,
      inventoryValue: entry?.value ?? 0,
    };
  });
}

/**
 * A single warehouse/product(/variant)'s available quantity — 0 when no
 * balance row exists, and (unlike `getBalance`) never creates one. This is
 * the ONLY sanctioned way for a page or a stock-operation form to check
 * availability; `getBalance` takes a `Tx` and is for the posting engine
 * only.
 */
export async function availableFor(
  companyId: string,
  warehouseId: string,
  productId: string,
  variantId?: string | null,
): Promise<number> {
  const variantKey = variantId ?? "";
  const balance = await prisma.inventoryBalance.findUnique({
    where: { warehouseId_productId_variantKey: { warehouseId, productId, variantKey } },
  });
  if (!balance || balance.companyId !== companyId) return 0;
  return balance.availableQty;
}

export interface ProductStockRow {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  variantId: string | null;
  availableQty: number;
  reservedQty: number;
  damagedQty: number;
  avgCost: number;
  inventoryValue: number;
}

/**
 * The raw warehouse x variant stock breakdown for one product — the product
 * DETAIL page derives both its "stock per warehouse" section (group by
 * warehouseId, summed across variants) and each row of the variants table's
 * "stock" column (group by variantId, summed across warehouses) from this
 * same list, rather than two separate queries.
 */
export async function productStockDetail(
  companyId: string,
  productId: string,
): Promise<ProductStockRow[]> {
  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId, productId },
    include: { warehouse: { select: { name: true, code: true } } },
  });

  return balances.map((b) => ({
    warehouseId: b.warehouseId,
    warehouseName: b.warehouse.name,
    warehouseCode: b.warehouse.code,
    variantId: b.variantId,
    availableQty: b.availableQty,
    reservedQty: b.reservedQty,
    damagedQty: b.damagedQty,
    avgCost: b.avgCost,
    inventoryValue: costOf(b.availableQty, b.avgCost),
  }));
}

// ---------- Contribution margin waterfall (3PL reconciliation stage) ----------

export interface ProfitWaterfallRow {
  productId: string;
  nameAr: string;
  nameEn: string;
  revenue: number;
  cogs: number;
  orderCosts: number;
  /** Line grain, stored, immutable: revenue - cogs - order costs. */
  cm1: number;
  advertising: number;
  /** Period grain, computed. */
  cm2: number;
  shrinkage: number;
  /** Period grain, computed. */
  cm3: number;
  /**
   * True when the shrinkage came from a reconciliation the merchant marked as
   * NOT a physical count. Spec section 7: a read from the warehouse's own
   * system may be their bookkeeping error rather than a real loss, yet it
   * arrives in CM3 in the same font as COGS. The caveat has to reach the
   * screen.
   */
  shrinkageIsIndicative: boolean;
}

/**
 * What each product actually earned, after goods, order costs, advertising and
 * unexplained stock loss.
 *
 * CM1 is derived exactly as bestSellers derives net profit — from stored,
 * immutable line data — so the two reports can never disagree. CM2 and CM3 are
 * period-grain and computed here on every read, never stored: an advertising
 * invoice that arrives late must restate the period, and a stored allocation
 * would leave one product showing two different profits.
 */
export async function profitWaterfall(
  companyId: string,
  range: DateRange,
  adSpendByProduct: Map<string, number>,
): Promise<ProfitWaterfallRow[]> {
  const window = dayWindow(range);

  const items = await prisma.salesOrderItem.findMany({
    where: {
      salesOrder: {
        companyId,
        status: { in: LIVE_ORDER_STATUSES },
        orderDate: window,
      },
    },
    select: {
      productId: true, lineTotal: true, totalCost: true,
      returnedRevenue: true, returnedCost: true,
      allocatedShipping: true, allocatedPlatformFee: true, allocatedPaymentFee: true,
      allocatedCommission: true, allocatedOtherCost: true,
      product: { select: { nameAr: true, nameEn: true } },
    },
  });

  const rows = new Map<string, ProfitWaterfallRow>();
  const blank = (productId: string, nameAr: string, nameEn: string): ProfitWaterfallRow => ({
    productId, nameAr, nameEn,
    revenue: 0, cogs: 0, orderCosts: 0, cm1: 0,
    advertising: 0, cm2: 0, shrinkage: 0, cm3: 0,
    shrinkageIsIndicative: false,
  });

  for (const item of items) {
    const row = rows.get(item.productId)
      ?? blank(item.productId, item.product.nameAr, item.product.nameEn);
    // Same derivation as bestSellers: posting-time snapshots stay gross and the
    // deltas live in returned*, so net them here rather than trusting the
    // stored grossProfit/netProfit columns.
    const netRevenue = item.lineTotal - item.returnedRevenue;
    const netCost = item.totalCost - item.returnedCost;
    row.revenue += netRevenue;
    row.cogs += netCost;
    row.orderCosts += item.allocatedShipping + item.allocatedPlatformFee
      + item.allocatedPaymentFee + item.allocatedCommission + item.allocatedOtherCost;
    rows.set(item.productId, row);
  }

  // Stock loss posted by a reconciliation in the window, valued at the
  // movement's own snapshot cost rather than today's average.
  //
  // OUT legs only. A damage reclassification posts a PAIR — ADJUSTMENT_OUT
  // from AVAILABLE and an IN to DAMAGED — carrying the same quantity and
  // cost; summing both legs doubled every damage write-off. The OUT leg
  // alone is the value leaving the books, once per loss whether it is
  // unexplained shrinkage or confirmed damage.
  const shrinkageMovements = await prisma.inventoryMovement.findMany({
    where: {
      companyId,
      referenceType: "RECONCILIATION",
      direction: "OUT",
      movementDate: window,
    },
    select: {
      productId: true, quantity: true, unitCost: true, referenceId: true,
      product: { select: { nameAr: true, nameEn: true } },
    },
  });

  // Whether each reconciliation was a physical count is recorded on the audit
  // entry rather than on a column of its own.
  //
  // COMPROMISE, recorded so it is not mistaken for a design: postReconcile has
  // no session row to hang this on, so the flag is read back out of the audit
  // log's JSON. It is durable and tenant-scoped, but it is not a queryable
  // column and it will not survive a change to the audit payload. The proper
  // fix is a ReconciliationSession model, which needs its own schema push.
  //
  // The window is deliberately NOT the same as the movement window. Movements
  // are dated `asOf` — the day the warehouse's figures describe — while the
  // audit row is written when the posting happened, which can be days later.
  // Filtering both on the same window silently dropped the caveat whenever
  // they diverged, presenting a warehouse-system figure in CM3 with the same
  // authority as COGS. Audit rows are read unbounded per product instead.
  const shrinkageProductIds = [...new Set(shrinkageMovements.map((m) => m.productId))];
  const audits = shrinkageProductIds.length === 0 ? [] : await prisma.auditLog.findMany({
    where: {
      companyId,
      action: "RECONCILIATION_POSTED",
      entityId: { in: shrinkageProductIds },
    },
    select: { entityId: true, newValues: true },
    orderBy: { createdAt: "desc" },
  });

  // Default is INDICATIVE. Every way of failing to establish the flag — no
  // session, no audit row, a pruned one, null newValues, malformed JSON, a
  // renamed key — must land on the cautious answer. Defaulting to "confirmed
  // physical count" would present the warehouse's own unverified bookkeeping
  // as a verified loss, which is the precise thing the caveat exists to prevent.
  //
  // The verdict is PER MOVEMENT, never per product. A product-level set let a
  // June system-figure loss inherit a January physical count's credibility —
  // any physical count, ever, silently removed the caveat from every later
  // unverified loss on the same product.

  // Primary source: the movement points at its ReconciliationSession, which
  // holds the flag in a real column.
  const sessionIds = [...new Set(shrinkageMovements.map((m) => m.referenceId))];
  const sessions = sessionIds.length === 0 ? [] : await prisma.reconciliationSession.findMany({
    where: { companyId, id: { in: sessionIds } },
    select: { id: true, isPhysicalCount: true },
  });
  const physicalBySession = new Map(sessions.map((s) => [s.id, s.isPhysicalCount]));

  // Fallback for reconciliations posted before sessions existed, whose
  // movements carry a synthetic composite referenceId that matches no session.
  // Kept rather than dropped so already-posted work is not silently downgraded.
  // Product-scoped and unbounded by necessity — those legacy movements carry
  // nothing better to join on — so it applies ONLY to movements that resolve
  // to no session at all.
  const legacyAuditPhysical = new Set<string>();
  for (const audit of audits) {
    if (!audit.newValues) continue;
    try {
      const parsed = JSON.parse(audit.newValues) as { isPhysicalCount?: boolean };
      if (parsed.isPhysicalCount === true) legacyAuditPhysical.add(audit.entityId);
    } catch {
      // Leave it out of the confirmed set: the movement stays indicative.
    }
  }

  const movementIsConfirmed = (movement: { referenceId: string; productId: string }) => {
    const sessionFlag = physicalBySession.get(movement.referenceId);
    if (sessionFlag !== undefined) return sessionFlag;
    return legacyAuditPhysical.has(movement.productId);
  };

  for (const movement of shrinkageMovements) {
    let row = rows.get(movement.productId);
    if (!row) {
      // A product that lost stock but sold nothing in the window still belongs
      // in a report whose whole purpose is profit AFTER loss. Skipping it made
      // the loss vanish entirely.
      row = blank(movement.productId, movement.product.nameAr, movement.product.nameEn);
      rows.set(movement.productId, row);
    }
    row.shrinkage += costOf(movement.quantity, movement.unitCost);
    if (!movementIsConfirmed(movement)) row.shrinkageIsIndicative = true;
  }

  for (const row of rows.values()) {
    row.cm1 = row.revenue - row.cogs - row.orderCosts;
    row.advertising = adSpendByProduct.get(row.productId) ?? 0;
    row.cm2 = row.cm1 - row.advertising;
    row.cm3 = row.cm2 - row.shrinkage;
  }

  return [...rows.values()].sort((a, b) => b.cm3 - a.cm3);
}

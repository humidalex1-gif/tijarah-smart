import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { productStockDetail, LIVE_ORDER_STATUSES } from "@/services/reporting";
import { fromCost, unitCostFrom } from "@/lib/money";
import { formatQty, formatBusinessDate, formatPct } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ProductDetailActions } from "./ProductDetailActions";
import { VariantSection, type VariantRow } from "./VariantSection";

interface WarehouseRow {
  id: string;
  warehouseName: string;
  warehouseCode: string;
  availableQty: number;
  reservedQty: number;
  damagedQty: number;
  avgCost: number;
  inventoryValue: number;
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "products.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter: a
  // product id from another company, or one that no longer exists, must read
  // as a routine 404 for this page, not a tenant-boundary leak or a 500.
  const product = await prisma.product.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      category: true,
      brand: true,
      variants: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!product) notFound();

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canViewMargin = canViewCost && can(ctx.role, "finance.view_profit");
  const canEdit = can(ctx.role, "products.edit");
  const canArchive = can(ctx.role, "products.archive");

  const [stockDetail, movements, salesItems, purchaseItems] = await Promise.all([
    productStockDetail(ctx.companyId, product.id),
    prisma.inventoryMovement.findMany({
      where: { companyId: ctx.companyId, productId: product.id },
      orderBy: { movementDate: "desc" },
      include: { warehouse: { select: { name: true } } },
    }),
    prisma.salesOrderItem.findMany({
      where: { productId: product.id, salesOrder: { companyId: ctx.companyId } },
      include: { salesOrder: { select: { salesOrderNumber: true, orderDate: true, status: true, customer: { select: { name: true } } } } },
      orderBy: { salesOrder: { orderDate: "desc" } },
    }),
    prisma.purchaseOrderItem.findMany({
      where: { productId: product.id, purchaseOrder: { companyId: ctx.companyId } },
      include: { purchaseOrder: { select: { purchaseOrderNumber: true, orderDate: true, status: true, supplier: { select: { name: true } } } } },
      orderBy: { purchaseOrder: { orderDate: "desc" } },
    }),
  ]);

  // "Stock by warehouse" sums every variant's balance into one row per
  // warehouse; the variants table (below) sums the same raw rows the other
  // way, by variant across warehouses — both views come from the same
  // `productStockDetail` call rather than two separate queries.
  const byWarehouse = new Map<string, {
    warehouseName: string; warehouseCode: string;
    availableQty: number; reservedQty: number; damagedQty: number; inventoryValue: number;
  }>();
  for (const row of stockDetail) {
    const entry = byWarehouse.get(row.warehouseId) ?? {
      warehouseName: row.warehouseName, warehouseCode: row.warehouseCode,
      availableQty: 0, reservedQty: 0, damagedQty: 0, inventoryValue: 0,
    };
    entry.availableQty += row.availableQty;
    entry.reservedQty += row.reservedQty;
    entry.damagedQty += row.damagedQty;
    entry.inventoryValue += row.inventoryValue;
    byWarehouse.set(row.warehouseId, entry);
  }
  const warehouseRows: WarehouseRow[] = [...byWarehouse.entries()].map(([warehouseId, w]) => ({
    id: warehouseId,
    warehouseName: w.warehouseName,
    warehouseCode: w.warehouseCode,
    availableQty: w.availableQty,
    reservedQty: w.reservedQty,
    damagedQty: w.damagedQty,
    inventoryValue: w.inventoryValue,
    avgCost: w.availableQty > 0 ? unitCostFrom(w.inventoryValue, w.availableQty) : 0,
  }));

  const totalAvailable = stockDetail.reduce((s, r) => s + r.availableQty, 0);
  const totalValue = stockDetail.reduce((s, r) => s + r.inventoryValue, 0);
  const overallAvgCost = totalAvailable > 0 ? unitCostFrom(totalValue, totalAvailable) : 0;
  // Gated on having an actual cost basis (see the identical note in the
  // products list page) — zero stock ever received should read "—", not a
  // misleading 100% margin.
  const marginPct = product.sellingPrice > 0 && totalAvailable > 0
    ? Math.round(((product.sellingPrice - fromCost(overallAvgCost)) / product.sellingPrice) * 10_000)
    : null;

  const byVariant = new Map<string, { qty: number; value: number }>();
  for (const row of stockDetail) {
    if (!row.variantId) continue;
    const entry = byVariant.get(row.variantId) ?? { qty: 0, value: 0 };
    entry.qty += row.availableQty;
    entry.value += row.inventoryValue;
    byVariant.set(row.variantId, entry);
  }
  const variantRows: VariantRow[] = product.variants.map((v) => {
    const stock = byVariant.get(v.id) ?? { qty: 0, value: 0 };
    return {
      id: v.id,
      name: v.name,
      sku: v.sku,
      barcode: v.barcode,
      attributes: v.attributes,
      sellingPrice: v.sellingPrice,
      status: v.status,
      statusLabel: t(`status.${v.status}`),
      availableQty: stock.qty,
      // Gated the same as every other cost figure on this page (see
      // warehouseRows/overallAvgCost above) — unlike those, this array is
      // serialized whole into VariantSection's props, a client component, so
      // an ungated value here would sit in the RSC flight payload where a
      // role without finance.view_cost could read it straight from devtools
      // even though the column itself is hidden.
      avgCost: canViewCost && stock.qty > 0 ? unitCostFrom(stock.value, stock.qty) : 0,
    };
  });

  const warehouseColumns: Column<WarehouseRow>[] = [
    { key: "warehouse", header: t("inventory.warehouse"), render: (r) => r.warehouseName },
    { key: "available", header: t("products.available"), align: "end", render: (r) => formatQty(r.availableQty, locale) },
    { key: "reserved", header: t("products.reservedQty"), align: "end", render: (r) => formatQty(r.reservedQty, locale) },
    { key: "damaged", header: t("inventory.damaged"), align: "end", render: (r) => formatQty(r.damagedQty, locale) },
    ...(canViewCost ? [{
      key: "avgCost", header: t("products.avgCost"), align: "end" as const,
      render: (r: WarehouseRow) => <Money minor={Math.round(fromCost(r.avgCost))} locale={locale} currency={ctx.currency} />,
    }, {
      key: "value", header: t("products.inventoryValue"), align: "end" as const,
      render: (r: WarehouseRow) => <Money minor={r.inventoryValue} locale={locale} currency={ctx.currency} />,
    }] : []),
  ];

  const movementColumns: Column<typeof movements[number]>[] = [
    { key: "date", header: t("app.date"), render: (m) => formatBusinessDate(m.movementDate, locale) },
    { key: "type", header: t("inventory.movementType"), render: (m) => t(`movement.${m.movementType}`) },
    { key: "warehouse", header: t("inventory.warehouse"), render: (m) => m.warehouse.name },
    {
      key: "quantity", header: t("inventory.quantity"), align: "end",
      render: (m) => `${m.direction === "IN" ? "+" : "-"}${formatQty(m.quantity, locale)}`,
    },
    ...(canViewCost ? [{
      key: "unitCost", header: t("inventory.unitCost"), align: "end" as const,
      render: (m: typeof movements[number]) => <Money minor={Math.round(fromCost(m.unitCost))} locale={locale} currency={ctx.currency} />,
    }] : []),
    {
      key: "balance", header: t("products.balanceAfter"), align: "end",
      render: (m) => formatQty(m.balanceAfter, locale),
    },
    { key: "reference", header: t("products.reference"), render: (m) => m.referenceNumber },
  ];

  // SalesOrderItem.quantity/netProfit are immutable posting-time snapshots
  // by design (docs/decisions.md #8): processReturn records deltas in
  // returnedQty/returnedRevenue/returnedCost without rewriting them, and
  // cancelSale zeroes only the SalesOrder row, never its items. Rendered raw,
  // this table would contradict the dashboard for the same order — derive
  // net figures the same way bestSellers() does (src/services/reporting.ts)
  // instead of mutating the stored snapshots. A line on a non-live order
  // (CANCELLED, or still DRAFT) contributes nothing, matching bestSellers'
  // own LIVE_ORDER_STATUSES filter, so it isn't shown as if it were live.
  const salesRows = salesItems.map((item) => {
    if (!LIVE_ORDER_STATUSES.includes(item.salesOrder.status)) {
      return { ...item, netQty: 0, netRevenue: 0, netProfitDerived: 0 };
    }
    const netRevenue = item.lineTotal - item.returnedRevenue;
    const netCost = item.totalCost - item.returnedCost;
    const allocated = item.allocatedShipping + item.allocatedPlatformFee
      + item.allocatedPaymentFee + item.allocatedCommission + item.allocatedOtherCost;
    return {
      ...item,
      netQty: item.quantity - item.returnedQty,
      netRevenue,
      netProfitDerived: netRevenue - netCost - allocated,
    };
  });

  const salesColumns: Column<typeof salesRows[number]>[] = [
    { key: "date", header: t("app.date"), render: (i) => formatBusinessDate(i.salesOrder.orderDate, locale) },
    { key: "order", header: t("products.orderNumber"), render: (i) => i.salesOrder.salesOrderNumber },
    { key: "customer", header: t("sales.customer"), render: (i) => i.salesOrder.customer?.name ?? t("sales.walkIn") },
    { key: "qty", header: t("inventory.quantity"), align: "end", render: (i) => formatQty(i.netQty, locale) },
    { key: "unitPrice", header: t("products.unitPrice"), align: "end", render: (i) => <Money minor={i.unitPrice} locale={locale} currency={ctx.currency} /> },
    // Netted the same way qty/profit are on this row (returnedRevenue
    // subtracted out) — rendering the gross `lineTotal` here instead would
    // make qty × unitPrice not reconcile with this figure within the same
    // row on any order with a partial return, and would still disagree with
    // the dashboard's bestSellers revenue for the same product.
    { key: "revenue", header: t("products.revenue"), align: "end", render: (i) => <Money minor={i.netRevenue} locale={locale} currency={ctx.currency} /> },
    ...(canViewMargin ? [{
      key: "profit", header: t("sales.profit"), align: "end" as const,
      render: (i: typeof salesRows[number]) => <Money minor={i.netProfitDerived} locale={locale} currency={ctx.currency} tone="auto" />,
    }] : []),
    { key: "status", header: t("app.status"), render: (i) => <StatusBadge label={t(`status.${i.salesOrder.status}`)} tone={i.salesOrder.status === "CANCELLED" ? "danger" : "success"} /> },
  ];

  const purchaseColumns: Column<typeof purchaseItems[number]>[] = [
    { key: "date", header: t("app.date"), render: (i) => formatBusinessDate(i.purchaseOrder.orderDate, locale) },
    { key: "order", header: t("products.orderNumber"), render: (i) => i.purchaseOrder.purchaseOrderNumber },
    { key: "supplier", header: t("purchases.supplier"), render: (i) => i.purchaseOrder.supplier.name },
    { key: "ordered", header: t("purchases.orderedQty"), align: "end", render: (i) => formatQty(i.orderedQty, locale) },
    { key: "received", header: t("purchases.receivedQty"), align: "end", render: (i) => formatQty(i.receivedQty, locale) },
    ...(canViewCost ? [{
      key: "unitCost", header: t("inventory.unitCost"), align: "end" as const,
      render: (i: typeof purchaseItems[number]) => <Money minor={i.unitPrice} locale={locale} currency={ctx.currency} />,
    }, {
      key: "landed", header: t("purchases.landedCost"), align: "end" as const,
      // `landedUnitCost` (like InventoryBalance.avgCost) is a COST_SCALE-scaled
      // unit cost, not a plain minor-unit amount — `fromCost` converts it
      // before it reaches <Money>, same as every avgCost column above.
      render: (i: typeof purchaseItems[number]) => (
        <Money minor={Math.round(fromCost(i.landedUnitCost))} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
    { key: "status", header: t("app.status"), render: (i) => <StatusBadge label={t(`status.${i.purchaseOrder.status}`)} tone={i.purchaseOrder.status === "CANCELLED" ? "danger" : "success"} /> },
  ];

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-lg font-semibold text-muted">
            {(locale === "ar" ? product.nameAr : product.nameEn).slice(0, 1)}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-navy">
              {locale === "ar" ? product.nameAr : product.nameEn}
            </h1>
            <p className="text-sm text-muted">{product.sku}{product.barcode ? ` · ${product.barcode}` : ""}</p>
            <div className="mt-1">
              <StatusBadge label={t(`status.${product.status}`)} tone={product.status === "ACTIVE" ? "success" : "neutral"} />
            </div>
          </div>
        </div>
        <ProductDetailActions
          locale={locale}
          productId={product.id}
          canEdit={canEdit}
          canArchive={canArchive}
          isArchived={product.status === "ARCHIVED"}
          labels={{
            edit: t("app.edit"), archive: t("products.archive"),
            archiveConfirmTitle: t("products.archiveConfirmTitle"),
            archiveConfirmMessage: t("products.archiveConfirmMessage"),
            confirm: t("app.confirm"), cancel: t("app.cancel"),
            errors: {
              "errors.generic": t("errors.generic"),
              "errors.ALREADY_ARCHIVED": t("errors.ALREADY_ARCHIVED"),
              "errors.FORBIDDEN": t("errors.FORBIDDEN"),
              "errors.NOT_FOUND": t("errors.NOT_FOUND"),
            },
          }}
        />
      </div>

      <PageSection title={t("products.overview")}>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">{t("products.currentStock")}</div>
            <div className="mt-1 text-lg font-semibold">{formatQty(totalAvailable, locale)}</div>
          </div>
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("products.inventoryValue")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={totalValue} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
          <div>
            <div className="text-xs text-muted">{t("products.sellingPrice")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={product.sellingPrice} locale={locale} currency={ctx.currency} /></div>
          </div>
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("products.avgCost")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={Math.round(fromCost(overallAvgCost))} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
          {canViewMargin ? (
            <div>
              <div className="text-xs text-muted">{t("products.margin")}</div>
              <div className="mt-1 text-lg font-semibold">{marginPct !== null ? formatPct(marginPct, locale) : "—"}</div>
            </div>
          ) : null}
        </div>
      </PageSection>

      <PageSection title={t("products.stockByWarehouse")}>
        <DataTable columns={warehouseColumns} rows={warehouseRows} empty={<EmptyState message={t("inventory.balances")} />} />
      </PageSection>

      {/* Nothing to show for a view-only role on a product with no variants
          yet: the add-variant form is gated on `products.create` (a
          SALES_EMPLOYEE has neither that nor any variants to list), so
          rendering an empty "Variants" section header for that combination
          would be a dead end rather than useful UI. */}
      {variantRows.length > 0 || can(ctx.role, "products.create") ? (
        <PageSection title={t("products.variant.title")}>
          <VariantSection
            productId={product.id}
            locale={locale}
            currency={ctx.currency}
            canViewCost={canViewCost}
            canCreate={can(ctx.role, "products.create")}
            variants={variantRows}
            labels={{
              title: t("products.variant.title"), add: t("products.variant.add"),
              name: t("products.variant.name"), sku: t("products.sku"), barcode: t("products.barcode"),
              attributes: t("products.variant.attributes"), attributeName: t("products.variant.attributeName"),
              attributeValue: t("products.variant.attributeValue"), addAttribute: t("products.variant.addAttribute"),
              avgCost: t("products.avgCost"), sellingPrice: t("products.sellingPrice"),
              purchasePrice: t("products.purchasePrice"),
              available: t("products.available"), status: t("app.status"),
              error: t("errors.generic"), empty: t("products.empty"), save: t("app.save"),
              duplicateSku: t("products.duplicateSku"),
            }}
          />
        </PageSection>
      ) : null}

      <PageSection title={t("products.movementHistory")}>
        <DataTable columns={movementColumns} rows={movements} empty={<EmptyState message={t("inventory.empty")} />} />
      </PageSection>

      <PageSection title={t("products.salesHistory")}>
        <DataTable columns={salesColumns} rows={salesRows} empty={<EmptyState message={t("sales.empty")} />} />
      </PageSection>

      <PageSection title={t("products.purchaseHistory")}>
        <DataTable columns={purchaseColumns} rows={purchaseItems} empty={<EmptyState message={t("purchases.empty")} />} />
      </PageSection>
    </div>
  );
}

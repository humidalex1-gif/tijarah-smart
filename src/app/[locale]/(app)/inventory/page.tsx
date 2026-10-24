import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import {
  balancesForCompany, warehouseSummary, lowStockProducts, outOfStockCount, type StockStatus,
} from "@/services/reporting";
import { formatQty, formatNumber } from "@/lib/format";
import { fromCost } from "@/lib/money";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { KpiCard } from "@/components/ui/KpiCard";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { InventoryNav } from "./InventoryNav";
import { InventoryFilters } from "./InventoryFilters";

const STOCK_STATUSES: readonly StockStatus[] = ["in", "low", "out"];
function isStockStatus(value: string): value is StockStatus {
  return (STOCK_STATUSES as readonly string[]).includes(value);
}

export default async function InventoryPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.view", locale);
  const t = await getTranslator(locale);

  const warehouseFilter = typeof sp.warehouse === "string" ? sp.warehouse : "";
  const categoryFilter = typeof sp.category === "string" ? sp.category : "";
  // `?filter=low` is the dashboard low-stock card's deep link; `?stock=` is
  // this page's own filter bar. The explicit `stock` param always wins if
  // both are somehow present.
  const rawStock = typeof sp.stock === "string" ? sp.stock : "";
  const stockFilter = rawStock || (sp.filter === "low" ? "low" : "");

  const canViewCost = can(ctx.role, "finance.view_cost");

  const [warehouses, categories, rows, summary, lowStock, outOfStock] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.productCategory.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { nameEn: "asc" } }),
    balancesForCompany(ctx.companyId, {
      warehouseId: warehouseFilter || undefined,
      categoryId: categoryFilter || undefined,
      stockStatus: isStockStatus(stockFilter) ? stockFilter : undefined,
    }),
    // The overview cards intentionally never move when the table's own
    // filters change (they come from warehouseSummary/lowStockProducts/
    // outOfStockCount, none of which take a filter).
    warehouseSummary(ctx.companyId),
    lowStockProducts(ctx.companyId),
    outOfStockCount(ctx.companyId),
  ]);

  const totalUnits = summary.reduce((s, w) => s + w.totalUnits, 0);
  const totalValue = summary.reduce((s, w) => s + w.inventoryValue, 0);
  const damagedUnits = summary.reduce((s, w) => s + w.damagedUnits, 0);
  const lowStockCount = lowStock.length;

  const tableRows = rows.map((r) => ({ ...r, id: `${r.productId}:${r.warehouseId}` }));

  const columns: Column<typeof tableRows[number]>[] = [
    {
      key: "product", header: t("dashboard.product"),
      render: (row) => (locale === "ar" ? row.nameAr : row.nameEn),
    },
    { key: "sku", header: t("products.sku"), render: (row) => row.sku },
    { key: "warehouse", header: t("inventory.warehouse"), render: (row) => row.warehouseName },
    {
      key: "available", header: t("products.available"), align: "end",
      render: (row) => formatQty(row.availableQty, locale),
    },
    {
      key: "damaged", header: t("inventory.damaged"), align: "end",
      render: (row) => formatQty(row.damagedQty, locale),
    },
    {
      key: "reorderLevel", header: t("products.reorderLevel"), align: "end",
      render: (row) => formatQty(row.reorderLevel, locale),
    },
    ...(canViewCost ? [{
      key: "avgCost", header: t("products.avgCost"), align: "end" as const,
      render: (row: typeof tableRows[number]) => (
        <Money minor={Math.round(fromCost(row.avgCost))} locale={locale} currency={ctx.currency} />
      ),
    }, {
      key: "value", header: t("products.inventoryValue"), align: "end" as const,
      render: (row: typeof tableRows[number]) => (
        <Money minor={row.value} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
    {
      key: "status", header: t("app.status"),
      render: (row) => (
        <StatusBadge
          label={t(`status.${row.status === "in" ? "inStock" : row.status === "low" ? "lowStock" : "outOfStock"}`)}
          tone={row.status === "in" ? "success" : row.status === "low" ? "warning" : "danger"}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHelp t={t} pageKey="inventory" />
      <InventoryNav locale={locale} role={ctx.role} t={t} active="overview" />

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label={t("warehouses.totalUnits")} value={formatQty(totalUnits, locale)} />
        {canViewCost ? (
          <KpiCard
            label={t("products.inventoryValue")}
            value={<Money minor={totalValue} locale={locale} currency={ctx.currency} />}
          />
        ) : null}
        <KpiCard label={t("inventory.damagedUnits")} value={formatQty(damagedUnits, locale)} />
        <KpiCard
          label={t("dashboard.lowStock")}
          value={formatNumber(lowStockCount, locale)}
          tone={lowStockCount > 0 ? "warning" : "neutral"}
        />
        <KpiCard
          label={t("inventory.outOfStockCount")}
          value={formatNumber(outOfStock, locale)}
          tone={outOfStock > 0 ? "danger" : "neutral"}
        />
      </div>

      <InventoryFilters
        categories={categories.map((c) => ({ id: c.id, label: locale === "ar" ? c.nameAr : c.nameEn }))}
        warehouses={warehouses.map((w) => ({ id: w.id, label: w.name }))}
        current={{ warehouse: warehouseFilter, category: categoryFilter, stock: stockFilter }}
        labels={{
          warehouse: t("inventory.warehouse"), category: t("products.category"),
          stockStatus: t("products.stockStatus"), all: t("app.all"),
          inStock: t("status.inStock"), lowStock: t("status.lowStock"), outOfStock: t("status.outOfStock"),
        }}
      />

      <DataTable columns={columns} rows={tableRows} empty={<EmptyState message={t("inventory.balances")} />} />
    </div>
  );
}

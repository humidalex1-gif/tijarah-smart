import Link from "next/link";
import type { ReactNode } from "react";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { parseRange, RANGE_KEYS, type SearchParams } from "@/lib/dateRange";
import {
  salesSummary, expenseTotal, inventoryValue, cashPosition,
  receivables, payables, lowStockProducts, bestSellers, salesSeries,
} from "@/services/reporting";
import { can, type Permission } from "@/lib/permissions";
import { formatQty, formatNumber, formatPct } from "@/lib/format";
import { KpiCard } from "@/components/ui/KpiCard";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { LineChart, type LineChartSeries } from "@/components/charts/LineChart";
import { SyncAlert } from "@/components/shell/SyncAlert";
import { TokenExpiryNotice } from "@/components/shell/TokenExpiryNotice";
import { getFastHubStatus } from "@/services/fasthub/connection";
import { describeAccessExpiry } from "@/services/fasthub/tokenExpiry";
import { explainDifferences } from "@/services/fasthub/explainDifferences";
import { stockoutForecast, type ForecastRow } from "@/services/forecast";
import { acknowledgeSyncAction } from "@/components/shell/acknowledgeSyncAction";
import { openSyncAttention } from "@/services/fasthub/syncRun";
import { pendingActions } from "@/services/attention";
import { PendingActions, type PendingRow } from "./PendingActions";

// Fixed-order categorical colors validated with the dataviz skill's
// scripts/validate_palette.js (light mode): PASS on lightness/chroma/CVD,
// WARN on surface contrast — mitigated by the legend + direct end-labels
// + hover tooltip below (never color-alone identity).
const REVENUE_COLOR = "var(--chart-revenue)";
const GROSS_PROFIT_COLOR = "var(--chart-gross-profit)";
const NET_PROFIT_COLOR = "var(--chart-net-profit)";

interface KpiDef {
  key: string;
  permission: Permission;
  extraPermission?: Permission;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  href: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  // Every (app) page must gate its own top-level permission — the layout is
  // presentation only, never a gate (docs/decisions.md #10). Use
  // `requirePermission`, NOT `assertCan`: `assertCan` throws
  // `ServiceError("FORBIDDEN")`, and a Server Component page has no catcher
  // for that throw in its tree, so it would render Next's default 500 page
  // for what is a ROUTINE denial (e.g. a SALES_EMPLOYEE opening /finance or
  // /expenses by URL — not an edge case). `requirePermission` redirects to
  // the dashboard instead. Every role in `PERMISSIONS` holds
  // `dashboard.view`, so this never actually redirects today; it exists so
  // Tasks 5–9, which copy this file's pattern, inherit THIS gate — not
  // `assertCan`.
  requirePermission(ctx, "dashboard.view", locale);
  const t = await getTranslator(locale);

  const range = parseRange(sp, locale);
  const todayRange = parseRange({ range: "today" }, locale);

  const [
    rangeSummary, todaySummary, expensesTotal, inventory, cash,
    owedByCustomers, owedToSuppliers, lowStock, topProducts, series,
  ] = await Promise.all([
    salesSummary(ctx.companyId, range),
    salesSummary(ctx.companyId, todayRange),
    expenseTotal(ctx.companyId, range),
    inventoryValue(ctx.companyId),
    cashPosition(ctx.companyId),
    receivables(ctx.companyId),
    payables(ctx.companyId),
    lowStockProducts(ctx.companyId),
    bestSellers(ctx.companyId, range),
    salesSeries(ctx.companyId, range),
  ]);

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canViewProfit = can(ctx.role, "finance.view_profit");
  const canViewSales = can(ctx.role, "sales.view");
  const canViewInventory = can(ctx.role, "inventory.view");
  // Gated on the permission that opens the Fast Hub screen: the banner's only
  // action is to go there, and pointing someone at a page they cannot open is
  // worse than not telling them.
  const canManageSync = can(ctx.role, "settings.edit");
  const [syncAttention, pending, fastHubStatus, forecast] = await Promise.all([
    canManageSync ? openSyncAttention(ctx.companyId) : Promise.resolve([]),
    pendingActions(ctx.companyId),
    // Same gate as the sync banner: the notice's only action is the Fast Hub
    // settings screen, and pointing someone at a page they cannot open is
    // worse than not telling them.
    canManageSync ? getFastHubStatus(ctx.companyId) : Promise.resolve(null),
    canViewInventory ? stockoutForecast(ctx.companyId) : Promise.resolve([]),
  ]);
  const tokenExpiry = fastHubStatus ? describeAccessExpiry(fastHubStatus, new Date()) : null;
  // The banner shows the LATEST run's differences, so that is the set explained.
  // syncAttention is already empty for a role that may not manage the sync.
  const explanations = syncAttention.length > 0
    ? await explainDifferences(ctx, syncAttention[0].attention.differences)
    : {};
  // Two weeks: enough to place an order and have it land at the warehouse.
  const RUNNING_OUT_WITHIN_DAYS = 14;
  const runningOut = forecast.filter((row) => row.daysOfCover <= RUNNING_OUT_WITHIN_DAYS);

  // Each row is gated on the permission of the screen it LINKS to, so the
  // card never offers a destination that would bounce, and a count that is
  // itself cost information (zeroCostSold) never reaches the RSC payload of
  // a role that may not see costs.
  const pendingRows: PendingRow[] = [
    {
      key: "zeroCostSold", count: pending.zeroCostSold,
      label: t("dashboard.pending.zeroCostSold"),
      href: `/${locale}/settings/salla`, permission: "finance.view_cost" as const,
    },
    {
      key: "openClaims", count: pending.openClaims,
      label: t("dashboard.pending.openClaims"),
      href: `/${locale}/claims`, permission: "reconcile.post" as const,
    },
    {
      key: "draftOrders", count: pending.draftOrders,
      label: t("dashboard.pending.draftOrders"),
      href: `/${locale}/sales`, permission: "sales.view" as const,
    },
    {
      key: "runningOut", count: runningOut.length,
      label: t("dashboard.pending.runningOut"),
      href: `/${locale}/dashboard#running-out`, permission: "inventory.view" as const,
    },
    {
      key: "lowStock", count: pending.lowStock,
      label: t("dashboard.pending.lowStock"),
      href: `/${locale}/inventory?filter=low`, permission: "inventory.view" as const,
    },
  ].filter((row) => can(ctx.role, row.permission)).map(({ permission: _p, ...row }) => row);

  const money = (minor: number) => (
    <Money minor={minor} locale={locale} currency={ctx.currency} />
  );

  const grossMarginPct = rangeSummary.revenue > 0
    ? Math.round((rangeSummary.grossProfit / rangeSummary.revenue) * 10_000)
    : null;
  const netMarginPct = rangeSummary.revenue > 0
    ? Math.round((rangeSummary.netProfit / rangeSummary.revenue) * 10_000)
    : null;

  const kpis: KpiDef[] = [
    {
      key: "salesToday",
      permission: "sales.view",
      label: t("dashboard.salesToday"),
      value: money(todaySummary.revenue),
      sub: t("dashboard.orders", { count: todaySummary.orderCount }),
      href: `/${locale}/sales`,
    },
    {
      key: "salesTotal",
      permission: "sales.view",
      label: t("dashboard.salesTotal"),
      value: money(rangeSummary.revenue),
      sub: t("dashboard.orders", { count: rangeSummary.orderCount }),
      href: `/${locale}/sales`,
    },
    {
      key: "grossProfit",
      permission: "sales.view",
      extraPermission: "finance.view_profit",
      label: t("dashboard.grossProfit"),
      value: money(rangeSummary.grossProfit),
      sub: grossMarginPct !== null ? formatPct(grossMarginPct, locale) : undefined,
      href: `/${locale}/sales`,
      tone: rangeSummary.grossProfit >= 0 ? "success" : "danger",
    },
    {
      key: "netProfit",
      permission: "sales.view",
      extraPermission: "finance.view_profit",
      label: t("dashboard.netProfit"),
      value: money(rangeSummary.netProfit),
      sub: netMarginPct !== null ? formatPct(netMarginPct, locale) : undefined,
      href: `/${locale}/sales`,
      tone: rangeSummary.netProfit >= 0 ? "success" : "danger",
    },
    {
      key: "expenses",
      permission: "expenses.view",
      label: t("dashboard.expenses"),
      value: money(expensesTotal),
      href: `/${locale}/expenses`,
    },
    {
      key: "inventoryValue",
      permission: "inventory.view",
      extraPermission: "finance.view_cost",
      label: t("dashboard.inventoryValue"),
      value: money(inventory.totalValue),
      sub: `${t("warehouses.totalUnits")}: ${formatQty(inventory.totalUnits, locale)}`,
      href: `/${locale}/inventory`,
    },
    {
      key: "cashBalance",
      permission: "finance.view",
      label: t("dashboard.cashBalance"),
      value: money(cash.total),
      sub: (
        <span>
          {t("finance.cash")} {money(cash.cash)} &middot; {t("finance.bank")} {money(cash.bank)}
        </span>
      ),
      href: `/${locale}/finance`,
    },
    {
      key: "receivables",
      permission: "customers.view",
      label: t("dashboard.receivables"),
      value: money(owedByCustomers),
      href: `/${locale}/customers?filter=owing`,
    },
    {
      key: "payables",
      permission: "suppliers.view",
      // Purchase-side money is gated on finance.view_cost everywhere else
      // (purchases list/detail, warehouses, inventory, products) — the
      // suppliers list itself removes its balance column for a role without
      // it. This KPI used to leak the payables total to anyone holding
      // suppliers.view alone, who could then click through to a screen that
      // hides the very figure they just saw (Stage 1B review, IMPORTANT 5).
      extraPermission: "finance.view_cost",
      label: t("dashboard.payables"),
      value: money(owedToSuppliers),
      href: `/${locale}/suppliers?filter=owing`,
      tone: owedToSuppliers > 0 ? "warning" : "neutral",
    },
    {
      key: "lowStock",
      permission: "inventory.view",
      label: t("dashboard.lowStock"),
      value: formatNumber(lowStock.length, locale),
      href: `/${locale}/inventory?filter=low`,
      tone: lowStock.length > 0 ? "warning" : "neutral",
    },
  ];

  const visibleKpis = kpis.filter(
    (k) => can(ctx.role, k.permission) && (!k.extraPermission || can(ctx.role, k.extraPermission)),
  );

  const chartSeries: LineChartSeries[] = [
    {
      label: t("dashboard.revenue"),
      color: REVENUE_COLOR,
      points: series.map((d) => ({ x: d.date, y: d.revenue })),
    },
    ...(canViewProfit
      ? [
        {
          label: t("dashboard.grossProfit"),
          color: GROSS_PROFIT_COLOR,
          points: series.map((d) => ({ x: d.date, y: d.grossProfit })),
        },
        {
          label: t("dashboard.netProfit"),
          color: NET_PROFIT_COLOR,
          points: series.map((d) => ({ x: d.date, y: d.netProfit })),
        },
      ]
      : []),
  ];

  const bestSellerRows = topProducts.map((p) => ({ ...p, id: p.productId }));
  const bestSellerColumns: Column<typeof bestSellerRows[number]>[] = [
    {
      key: "product", header: t("dashboard.product"),
      render: (row) => (locale === "ar" ? row.nameAr : row.nameEn),
    },
    {
      key: "units", header: t("dashboard.unitsSold"), align: "end",
      render: (row) => formatQty(row.unitsSold, locale),
    },
    {
      key: "revenue", header: t("dashboard.revenue"), align: "end",
      render: (row) => money(row.revenue),
    },
    ...(canViewProfit
      ? [
        {
          key: "grossProfit", header: t("dashboard.grossProfit"), align: "end" as const,
          render: (row: typeof bestSellerRows[number]) => money(row.grossProfit),
        },
        {
          key: "netProfit", header: t("dashboard.netProfit"), align: "end" as const,
          render: (row: typeof bestSellerRows[number]) => money(row.netProfit),
        },
      ]
      : []),
  ];

  const lowStockRows = lowStock.map((p) => ({ ...p, id: p.productId }));
  const lowStockColumns: Column<typeof lowStockRows[number]>[] = [
    {
      key: "product", header: t("dashboard.product"),
      render: (row) => (locale === "ar" ? row.nameAr : row.nameEn),
    },
    {
      key: "available", header: t("products.available"), align: "end",
      render: (row) => formatQty(row.availableQty, locale),
    },
    {
      key: "reorderLevel", header: t("products.reorderLevel"), align: "end",
      render: (row) => formatQty(row.reorderLevel, locale),
    },
  ];

  // Per-day and on-hand are thousandths, as everywhere; days are shown whole
  // and rounded DOWN, because "12 days" for 12.9 errs on the side of ordering.
  const forecastColumns: Column<ForecastRow & { id: string }>[] = [
    {
      key: "product", header: t("dashboard.forecast.product"),
      render: (row) => (
        <Link href={`/${locale}/products/${row.productId}`} className="font-medium text-brand hover:underline">
          {locale === "ar" ? row.nameAr : row.nameEn}
        </Link>
      ),
    },
    { key: "onHand", header: t("dashboard.forecast.onHand"), align: "end", render: (row) => formatQty(row.availableQty, locale) },
    { key: "perDay", header: t("dashboard.forecast.perDay"), align: "end", render: (row) => formatQty(Math.round(row.unitsPerDay), locale) },
    {
      key: "daysLeft", header: t("dashboard.forecast.daysLeft"), align: "end",
      render: (row) => (
        <span className={`font-semibold ${row.daysOfCover <= 7 ? "text-danger" : "text-warning"}`}>
          {formatNumber(Math.floor(row.daysOfCover), locale)}
        </span>
      ),
    },
    { key: "order", header: t("dashboard.forecast.order"), align: "end", render: (row) => <span className="font-semibold">{formatQty(row.suggestedQty, locale)}</span> },
  ];


  return (
    <div>
      {/* Above the help panel and the range filter: the sync runs unattended,
          so what it could not resolve is the first thing the owner needs,
          before any figure below is trusted. */}
      <TokenExpiryNotice expiry={tokenExpiry} locale={locale} t={t} />
      <SyncAlert
        runs={syncAttention}
        locale={locale}
        t={t}
        acknowledge={acknowledgeSyncAction}
        explanations={explanations}
      />

      <div className="mb-6">
        <PageHelp t={t} pageKey="dashboard" />
      </div>

      {/* Pending work, one place. Renders nothing when nothing is pending. */}
      <PendingActions title={t("dashboard.pending.title")} rows={pendingRows} locale={locale} />
      <div className="mb-6 flex flex-wrap gap-2">
        {RANGE_KEYS.filter((key) => key !== "custom").map((key) => (
          <Link
            key={key}
            // `/${locale}` belongs to the MARKETING landing page, not this one.
            // The dashboard moved to /${locale}/dashboard when that page was
            // added on 2026-08-05 and these links were left behind, so every
            // range tab walked the owner out of the app onto the public front
            // door — which reads as being logged out, and was reported as that.
            href={`/${locale}/dashboard?range=${key}`}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              range.key === key
                ? "border-brand bg-brand text-brand-ink"
                : "border-line bg-panel text-navy hover:bg-surface"
            }`}
          >
            {t(`dashboard.range.${key}`)}
          </Link>
        ))}
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {visibleKpis.map((kpi) => (
          <KpiCard
            key={kpi.key}
            label={kpi.label}
            value={kpi.value}
            sub={kpi.sub}
            tone={kpi.tone}
            href={kpi.href}
          />
        ))}
      </div>

      {canViewSales ? (
        rangeSummary.orderCount === 0 ? (
          <PageSection>
            <EmptyState message={t("dashboard.noSales")} />
          </PageSection>
        ) : (
          <>
            <PageSection title={t("dashboard.salesChart")}>
              <div className="rounded-xl border border-line bg-panel p-4">
                <LineChart
                  series={chartSeries}
                  locale={locale}
                  currency={ctx.currency}
                />
              </div>
            </PageSection>

            <PageSection title={t("dashboard.bestSellers")}>
              <DataTable
                columns={bestSellerColumns}
                rows={bestSellerRows}
                empty={<EmptyState message={t("dashboard.noSales")} />}
              />
              {canViewProfit ? (
                <p className="mt-2 text-xs text-muted">{t("dashboard.profitFootnote")}</p>
              ) : null}
            </PageSection>
          </>
        )
      ) : null}

      {canViewInventory ? (
        <div id="running-out">
          <PageSection title={t("dashboard.forecast.title")}>
            <p className="mb-3 text-xs leading-relaxed text-muted">
              {t("dashboard.forecast.intro", { window: formatNumber(30, locale), cover: formatNumber(30, locale) })}
            </p>
            <DataTable
              columns={forecastColumns}
              rows={runningOut.map((row) => ({ ...row, id: row.productId }))}
              empty={<EmptyState message={t("dashboard.forecast.empty")} />}
            />
          </PageSection>
        </div>
      ) : null}

      {canViewInventory ? (
        <PageSection title={t("dashboard.needsAttention")}>
          <DataTable
            columns={lowStockColumns}
            rows={lowStockRows}
            empty={<EmptyState message={t("dashboard.allStocked")} />}
          />
        </PageSection>
      ) : null}
    </div>
  );
}

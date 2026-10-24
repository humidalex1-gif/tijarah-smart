import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { formatMoney } from "@/lib/format";
import { Money } from "@/components/ui/Money";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { profitWaterfall } from "@/services/reporting";
import { adSpendForPeriod } from "@/services/adspend";

/**
 * What each product actually earned, after goods, order costs, advertising and
 * unexplained stock loss.
 *
 * CM1 comes from stored, immutable line data. CM2 and CM3 are computed here on
 * every read, never stored — an advertising invoice that arrives late must
 * restate the period rather than leaving one product with two different
 * profits depending on which report was opened.
 */
export default async function ProfitPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  // BOTH permissions, deliberately. The table renders raw COGS and order
  // costs, not only margin, and this codebase's convention for a margin view
  // is the AND of the two — products/page.tsx and products/[id]/page.tsx both
  // do it. Gating on profit alone would leak cost to any future role granted
  // finance.view_profit without finance.view_cost.
  requirePermission(ctx, "finance.view_profit", locale);
  requirePermission(ctx, "finance.view_cost", locale);
  const t = await getTranslator(locale);

  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = typeof sp.from === "string" ? new Date(sp.from) : defaultFrom;
  const to = typeof sp.to === "string" ? new Date(sp.to) : now;
  const range = {
    from: Number.isNaN(from.getTime()) ? defaultFrom : from,
    to: Number.isNaN(to.getTime()) ? now : to,
  };

  // Revenue first, so untagged advertising can be allocated by revenue share.
  // A pass with no ad spend gives the revenue figures the allocation needs;
  // the second pass applies them. Both are reads — nothing is written.
  const revenueOnly = await profitWaterfall(ctx.companyId, range, new Map());
  const revenueByProduct = new Map(revenueOnly.map((r) => [r.productId, r.revenue]));
  const ads = await adSpendForPeriod(ctx, { from: range.from, to: range.to, revenueByProduct });
  const rows = await profitWaterfall(ctx.companyId, range, ads.byProduct);

  const currency = ctx.currency;
  const anyIndicative = rows.some((r) => r.shrinkageIsIndicative);

  // DataTable keys rows by `id`; the waterfall keys them by product.
  const tableRows = rows.map((row) => ({ ...row, id: row.productId }));
  type ProfitRow = (typeof tableRows)[number];
  const money = (minor: number) => (
    <span className="tabular-nums">{formatMoney(minor, locale, currency)}</span>
  );
  // The four margin figures say when they are a loss; the always-positive
  // deduction columns stay plain.
  const margin = (minor: number) => (
    <span className="tabular-nums"><Money minor={minor} locale={locale} currency={currency} tone="loss" /></span>
  );
  const columns: Column<ProfitRow>[] = [
    { key: "product", header: t("profit.product"), render: (r) => (locale === "ar" ? r.nameAr : r.nameEn) },
    { key: "revenue", header: t("profit.revenue"), align: "end", render: (r) => margin(r.revenue) },
    { key: "cogs", header: t("profit.cogs"), align: "end", render: (r) => money(r.cogs) },
    { key: "orderCosts", header: t("profit.orderCosts"), align: "end", render: (r) => money(r.orderCosts) },
    { key: "cm1", header: t("profit.cm1"), align: "end", render: (r) => margin(r.cm1) },
    { key: "advertising", header: t("profit.advertising"), align: "end", render: (r) => money(r.advertising) },
    { key: "cm2", header: t("profit.cm2"), align: "end", render: (r) => margin(r.cm2) },
    {
      key: "shrinkage", header: t("profit.shrinkage"), align: "end",
      render: (r) => (
        <>
          {money(r.shrinkage)}
          {r.shrinkageIsIndicative ? (
            <span className="ms-1 rounded bg-warning-soft px-1 text-xs text-warning">
              {t("profit.indicative")}
            </span>
          ) : null}
        </>
      ),
    },
    { key: "cm3", header: t("profit.cm3"), align: "end", render: (r) => <span className="font-medium">{margin(r.cm3)}</span> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-muted">{t("profit.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="profit" />

      {rows.length === 0 ? (
        <EmptyState message={t("profit.empty")} />
      ) : (
        <>
          <DataTable columns={columns} rows={tableRows} empty={null} />

          {anyIndicative ? (
            <p className="rounded-lg bg-warning-soft p-3 text-sm text-warning">
              {t("profit.indicativeHint")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

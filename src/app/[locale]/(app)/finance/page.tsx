import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { parseRange } from "@/lib/dateRange";
import {
  cashPosition, receivables, payables, salesSummary, expenseTotal,
} from "@/services/reporting";
import { KpiCard } from "@/components/ui/KpiCard";
import { Money } from "@/components/ui/Money";
import { FinanceNav } from "./FinanceNav";

export default async function FinanceOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "finance.view", locale);
  const t = await getTranslator(locale);

  const thisMonth = parseRange({ range: "month" }, locale);

  const [cash, owedByCustomers, owedToSuppliers, monthSales, monthExpenses] = await Promise.all([
    cashPosition(ctx.companyId),
    receivables(ctx.companyId),
    payables(ctx.companyId),
    salesSummary(ctx.companyId, thisMonth),
    expenseTotal(ctx.companyId, thisMonth),
  ]);

  const money = (minor: number) => <Money minor={minor} locale={locale} currency={ctx.currency} />;
  // Net profit here is broader than salesSummary's own netProfit (which is
  // per-order-line, before operating expenses): revenue-side net profit less
  // this month's recorded operating expenses, matching the "net profit"
  // figure a merchant actually cares about on a finance overview.
  const netProfitThisMonth = monthSales.netProfit - monthExpenses;

  return (
    <div>
      <PageHelp t={t} pageKey="finance" />
      <FinanceNav locale={locale} role={ctx.role} t={t} active="overview" />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={t("finance.cash")} value={money(cash.cash)} href={`/${locale}/finance/accounts`} />
        <KpiCard label={t("finance.bank")} value={money(cash.bank)} href={`/${locale}/finance/accounts`} />
        <KpiCard label={t("dashboard.cashBalance")} value={money(cash.total)} href={`/${locale}/finance/accounts`} />
        <KpiCard
          label={t("finance.receivables")} value={money(owedByCustomers)}
          href={`/${locale}/customers?filter=owing`}
        />
        <KpiCard
          label={t("finance.payables")} value={money(owedToSuppliers)}
          href={`/${locale}/suppliers?filter=owing`}
          tone={owedToSuppliers > 0 ? "warning" : "neutral"}
        />
        <KpiCard
          label={t("finance.incomeThisMonth")} value={money(monthSales.revenue)}
          href={`/${locale}/sales`}
        />
        <KpiCard
          label={t("finance.expensesThisMonth")} value={money(monthExpenses)}
          href={`/${locale}/expenses`}
        />
        <KpiCard
          label={t("finance.netProfitThisMonth")} value={money(netProfitThisMonth)}
          href={`/${locale}/finance/transactions`}
          tone={netProfitThisMonth >= 0 ? "success" : "danger"}
        />
      </div>
    </div>
  );
}

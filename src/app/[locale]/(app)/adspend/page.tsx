import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { formatBusinessDate, formatMoney } from "@/lib/format";
import { AD_CHANNELS } from "@/lib/constants";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { AdSpendForm } from "./AdSpendForm";

/**
 * Advertising spend, entered per period.
 *
 * It never touches product cost. It is subtracted from profit at CM2, and the
 * allocation of untagged spend across products is computed on read — see
 * src/services/adspend.ts for why storing it would rewrite history.
 */
export default async function AdSpendPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "adspend.manage", locale);
  const t = await getTranslator(locale);

  const [rows, products] = await Promise.all([
    prisma.adSpend.findMany({
      where: { companyId: ctx.companyId },
      orderBy: { periodStart: "desc" },
      take: 50,
      select: {
        id: true, channel: true, periodStart: true, periodEnd: true,
        amount: true, campaign: true,
        product: { select: { nameAr: true, nameEn: true } },
      },
    }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
  ]);

  const currency = ctx.currency;
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  type SpendRow = (typeof rows)[number];
  const columns: Column<SpendRow>[] = [
    { key: "channel", header: t("adspend.channel"), render: (r) => t(`adspend.channels.${r.channel}`) },
    { key: "periodStart", header: t("adspend.periodStart"), render: (r) => formatBusinessDate(r.periodStart, locale) },
    { key: "periodEnd", header: t("adspend.periodEnd"), render: (r) => formatBusinessDate(r.periodEnd, locale) },
    {
      key: "product", header: t("adspend.product"),
      render: (r) => (r.product ? (locale === "ar" ? r.product.nameAr : r.product.nameEn) : t("adspend.allProducts")),
    },
    { key: "campaign", header: t("adspend.campaign"), render: (r) => r.campaign ?? "—" },
    { key: "amount", header: t("adspend.amount"), align: "end", render: (r) => <span className="tabular-nums">{formatMoney(r.amount, locale, currency)}</span> },
  ];


  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("adspend.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("adspend.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="adspend" />

      <AdSpendForm
        channels={AD_CHANNELS.map((c) => ({ value: c, label: t(`adspend.channels.${c}`) }))}
        products={products.map((p) => ({
          id: p.id,
          name: locale === "ar" ? p.nameAr : p.nameEn,
        }))}
        labels={{
          channel: t("adspend.channel"),
          periodStart: t("adspend.periodStart"),
          periodEnd: t("adspend.periodEnd"),
          amount: t("adspend.amount"),
          product: t("adspend.product"),
          campaign: t("adspend.campaign"),
          allProducts: t("adspend.allProducts"),
          add: t("adspend.add"),
          recorded: t("adspend.recorded"),
          generic: t("errors.generic"),
        }}
      />

      {rows.length === 0 ? (
        <EmptyState message={t("adspend.empty")} />
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-muted">
            {t("adspend.total")}: <span className="font-medium">{formatMoney(total, locale, currency)}</span>
          </div>
          <DataTable columns={columns} rows={rows} empty={null} />
        </div>
      )}
    </div>
  );
}

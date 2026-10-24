import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { can } from "@/lib/permissions";
import { warehouseSummary } from "@/services/reporting";
import { formatQty, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default async function WarehousesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "warehouses.view", locale);
  const t = await getTranslator(locale);

  const canViewCost = can(ctx.role, "finance.view_cost");
  const rows = (await warehouseSummary(ctx.companyId)).map((w) => ({ ...w, id: w.warehouseId }));

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "name", header: t("warehouses.name"),
      render: (row) => (
        <Link href={`/${locale}/warehouses/${row.id}`} className="font-medium text-brand hover:underline">
          {row.warehouseName}
        </Link>
      ),
    },
    { key: "code", header: t("warehouses.code"), render: (row) => row.warehouseCode },
    { key: "city", header: t("warehouses.city"), render: (row) => row.city ?? "—" },
    {
      key: "skus", header: t("warehouses.totalSkus"), align: "end",
      render: (row) => formatNumber(row.skuCount, locale),
    },
    {
      key: "units", header: t("warehouses.totalUnits"), align: "end",
      render: (row) => formatQty(row.totalUnits, locale),
    },
    ...(canViewCost ? [{
      key: "value", header: t("warehouses.value"), align: "end" as const,
      render: (row: typeof rows[number]) => (
        <Money minor={row.inventoryValue} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
    {
      key: "status", header: t("app.status"),
      render: (row) => (
        <StatusBadge label={t(`status.${row.status}`)} tone={row.status === "ACTIVE" ? "success" : "neutral"} />
      ),
    },
  ];

  return (
    <div>
      {can(ctx.role, "warehouses.create") ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Link
            href={`/${locale}/warehouses/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("warehouses.add")}
          </Link>
        </div>
      ) : null}

      <div className="mb-6">
        <PageHelp t={t} pageKey="warehouses" />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        empty={
          <EmptyState
            message={t("warehouses.empty")}
            actionLabel={can(ctx.role, "warehouses.create") ? t("warehouses.add") : undefined}
            actionHref={can(ctx.role, "warehouses.create") ? `/${locale}/warehouses/new` : undefined}
          />
        }
      />
    </div>
  );
}

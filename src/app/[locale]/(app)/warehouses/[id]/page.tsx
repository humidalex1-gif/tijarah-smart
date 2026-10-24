import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { balancesForCompany, warehouseSummary } from "@/services/reporting";
import { fromCost } from "@/lib/money";
import { formatQty, formatBusinessDateTime } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default async function WarehouseDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "warehouses.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter —
  // same tenant-boundary rule as products/[id]/page.tsx: an id from another
  // company, or one that no longer exists, must read as a routine 404.
  const warehouse = await prisma.warehouse.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!warehouse) notFound();

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canEdit = can(ctx.role, "warehouses.edit");

  const [summary, balances, movements] = await Promise.all([
    warehouseSummary(ctx.companyId),
    balancesForCompany(ctx.companyId, { warehouseId: warehouse.id }),
    prisma.inventoryMovement.findMany({
      where: { companyId: ctx.companyId, warehouseId: warehouse.id },
      orderBy: { movementDate: "desc" },
      take: 20,
      include: { product: { select: { nameAr: true, nameEn: true } } },
    }),
  ]);

  const own = summary.find((w) => w.warehouseId === warehouse.id);

  const balanceRows = balances.map((b) => ({ ...b, id: `${b.productId}:${b.warehouseId}` }));
  const balanceColumns: Column<typeof balanceRows[number]>[] = [
    {
      key: "product", header: t("dashboard.product"),
      render: (row) => (locale === "ar" ? row.nameAr : row.nameEn),
    },
    { key: "sku", header: t("products.sku"), render: (row) => row.sku },
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
      render: (row: typeof balanceRows[number]) => (
        <Money minor={Math.round(fromCost(row.avgCost))} locale={locale} currency={ctx.currency} />
      ),
    }, {
      key: "value", header: t("products.inventoryValue"), align: "end" as const,
      render: (row: typeof balanceRows[number]) => (
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

  const movementColumns: Column<typeof movements[number]>[] = [
    // Same UTC-pinned date+time as the movements list page (matches so this
    // "recent movements" preview never contradicts the full list).
    { key: "date", header: t("app.date"), render: (m) => formatBusinessDateTime(m.movementDate, locale) },
    {
      key: "product", header: t("dashboard.product"),
      render: (m) => (locale === "ar" ? m.product.nameAr : m.product.nameEn),
    },
    { key: "type", header: t("inventory.movementType"), render: (m) => t(`movement.${m.movementType}`) },
    {
      key: "quantity", header: t("inventory.quantity"), align: "end",
      render: (m) => `${m.direction === "IN" ? "+" : "-"}${formatQty(m.quantity, locale)}`,
    },
    { key: "reference", header: t("products.reference"), render: (m) => m.referenceNumber },
  ];

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">{warehouse.name}</h1>
          <p className="text-sm text-muted">{warehouse.code}{warehouse.city ? ` · ${warehouse.city}` : ""}</p>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge label={t(`status.${warehouse.status}`)} tone={warehouse.status === "ACTIVE" ? "success" : "neutral"} />
            {warehouse.isDefault ? (
              <StatusBadge label={t("warehouses.isDefault")} tone="neutral" />
            ) : null}
          </div>
        </div>
        {canEdit ? (
          <Link
            href={`/${locale}/warehouses/${warehouse.id}/edit`}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-navy hover:bg-surface"
          >
            {t("app.edit")}
          </Link>
        ) : null}
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
        <div>
          <div className="text-xs text-muted">{t("warehouses.totalSkus")}</div>
          <div className="mt-1 text-lg font-semibold">{own?.skuCount ?? 0}</div>
        </div>
        <div>
          <div className="text-xs text-muted">{t("warehouses.totalUnits")}</div>
          <div className="mt-1 text-lg font-semibold">{formatQty(own?.totalUnits ?? 0, locale)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">{t("inventory.damagedUnits")}</div>
          <div className="mt-1 text-lg font-semibold">{formatQty(own?.damagedUnits ?? 0, locale)}</div>
        </div>
        {canViewCost ? (
          <div>
            <div className="text-xs text-muted">{t("warehouses.value")}</div>
            <div className="mt-1 text-lg font-semibold">
              <Money minor={own?.inventoryValue ?? 0} locale={locale} currency={ctx.currency} />
            </div>
          </div>
        ) : null}
      </div>

      <PageSection title={t("products.sectionInventory")}>
        <DataTable columns={balanceColumns} rows={balanceRows} empty={<EmptyState message={t("inventory.balances")} />} />
      </PageSection>

      <PageSection title={t("warehouses.recentMovements")}>
        <DataTable
          columns={movementColumns}
          rows={movements}
          empty={<EmptyState message={t("inventory.empty")} />}
        />
      </PageSection>
    </div>
  );
}

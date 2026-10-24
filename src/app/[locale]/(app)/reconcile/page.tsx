import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReconcileForm } from "./ReconcileForm";

/**
 * Reconciling the merchant's books against what the fulfilment warehouse says
 * is on its shelf.
 *
 * The merchant types one number per product — two if the warehouse reports
 * sellable and damaged separately — and the screen shows the difference broken
 * into what is explained by outstanding claims and what is genuinely lost.
 * A single difference figure is not actionable; the decomposition is the
 * product.
 */
export default async function ReconcilePage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  // requirePermission redirects rather than returning, so everything below
  // runs only for a role that already holds reconcile.post. A second
  // can(ctx.role, "reconcile.post") would be the same pure function on the
  // same inputs and could never be false.
  requirePermission(ctx, "reconcile.post", locale);
  const t = await getTranslator(locale);

  const warehouses = await prisma.warehouse.findMany({
    where: { companyId: ctx.companyId },
    select: { id: true, name: true, isDefault: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  const requested = typeof sp.warehouseId === "string" ? sp.warehouseId : null;
  const selected = warehouses.find((w) => w.id === requested) ?? warehouses[0] ?? null;

  if (!selected) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{t("reconcile.title")}</h1>

        <PageHelp t={t} pageKey="reconcile" />
        <EmptyState message={t("reconcile.empty")} />
      </div>
    );
  }

  // Everything the merchant's books believe is at this warehouse, sellable or
  // in dispute. A product with nothing on either side is not worth a row.
  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId: ctx.companyId, warehouseId: selected.id },
    select: {
      productId: true,
      variantId: true,
      availableQty: true,
      disputedQty: true,
      product: { select: { nameAr: true, nameEn: true, sku: true } },
    },
  });

  const rows = balances
    .filter((b) => b.availableQty > 0 || b.disputedQty > 0)
    .map((b) => ({
      productId: b.productId,
      variantId: b.variantId,
      name: locale === "ar" ? b.product.nameAr : b.product.nameEn,
      sku: b.product.sku,
      onShelfQty: b.availableQty,
      inDisputeQty: b.disputedQty,
      expectedQty: b.availableQty + b.disputedQty,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("reconcile.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("reconcile.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="reconcile" />

      {rows.length === 0 ? (
        <EmptyState message={t("reconcile.empty")} />
      ) : (
        <ReconcileForm
          locale={locale}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          warehouseId={selected.id}
          rows={rows}
          labels={{
            warehouse: t("reconcile.warehouse"),
            asOf: t("reconcile.asOf"),
            product: t("reconcile.product"),
            sku: t("reconcile.sku"),
            expected: t("reconcile.expected"),
            sellable: t("reconcile.sellable"),
            damaged: t("reconcile.damaged"),
            gap: t("reconcile.gap"),
            settleable: t("reconcile.settleable"),
            stillClaimed: t("reconcile.stillClaimed"),
            unexplained: t("reconcile.unexplained"),
            surplus: t("reconcile.surplus"),
            isPhysicalCount: t("reconcile.isPhysicalCount"),
            isPhysicalCountHint: t("reconcile.isPhysicalCountHint"),
            preview: t("reconcile.preview"),
            onShelf: t("reconcile.onShelf"),
            inDispute: t("reconcile.inDispute"),
            fastHub: t("reconcile.fastHub"),
            theirOnHand: t("reconcile.theirOnHand"),
            syncedHint: t("reconcile.syncedHint"),
            post: t("reconcile.post"),
            posted: t("reconcile.posted"),
            settledCount: t("reconcile.settledCount"),
            shrinkagePosted: t("reconcile.shrinkagePosted"),
            damagedPosted: t("reconcile.damagedPosted"),
            skippedCount: t("reconcile.skippedCount"),
            generic: t("errors.generic"),
          }}
        />
      )}
    </div>
  );
}

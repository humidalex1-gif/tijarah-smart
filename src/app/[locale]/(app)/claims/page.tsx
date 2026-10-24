import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { formatBusinessDate, formatMoney, formatNumber, formatQty } from "@/lib/format";
import { costOf, unitCostFrom } from "@/lib/money";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { KpiCard } from "@/components/ui/KpiCard";
import { can } from "@/lib/permissions";
import { CLAIM_KINDS } from "@/lib/constants";
import { openClaims } from "@/services/claims";
import { OpenClaimForm } from "./OpenClaimForm";

/**
 * What the fulfilment warehouse owes the merchant: returns and damage it has
 * never confirmed receiving, oldest first, valued at cost.
 *
 * The point of this screen is a sentence the merchant can send to the
 * warehouse — "these 5 units went back 79 days ago and you have never
 * confirmed them" — rather than a vague sense that stock is missing.
 */
export default async function ClaimsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "reconcile.post", locale);
  const t = await getTranslator(locale);

  // Cost is gated separately from the page. Every comparable page in this
  // codebase does the same — inventory, products, purchases, warehouses,
  // suppliers. The page gate is reconcile.post; that a WAREHOUSE_MANAGER also
  // happens to hold finance.view_cost today is a coincidence of the role
  // matrix, not a reason to render money without checking.
  const canViewCost = can(ctx.role, "finance.view_cost");

  const claims = await openClaims(ctx, {});

  const productIds = [...new Set(claims.map((c) => c.productId))];
  const [products, balances, allProducts, warehouses] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, companyId: ctx.companyId },
      select: { id: true, nameAr: true, nameEn: true, sku: true },
    }),
    prisma.inventoryBalance.findMany({
      where: { companyId: ctx.companyId, productId: { in: productIds } },
      select: { productId: true, availableQty: true, disputedQty: true, avgCost: true },
    }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
    prisma.warehouse.findMany({
      where: { companyId: ctx.companyId },
      select: { id: true, name: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));

  // A product has one balance row PER WAREHOUSE and per variant, so keying a
  // Map by productId alone silently kept whichever row came last and valued
  // the claim at an arbitrary warehouse's average. This is a figure the
  // merchant invoices the warehouse with, so derive a proper weighted average
  // across the rows instead.
  const costById = new Map<string, number>();
  const totals = new Map<string, { qty: number; value: number }>();
  for (const b of balances) {
    const owned = b.availableQty + b.disputedQty;
    const entry = totals.get(b.productId) ?? { qty: 0, value: 0 };
    entry.qty += owned;
    entry.value += costOf(owned, b.avgCost);
    totals.set(b.productId, entry);
  }
  for (const [productId, entry] of totals) {
    costById.set(productId, entry.qty > 0 ? unitCostFrom(entry.value, entry.qty) : 0);
  }

  const rows = claims
    .map((claim) => {
      const product = productById.get(claim.productId);
      const avgCost = costById.get(claim.productId) ?? 0;
      return {
        ...claim,
        name: product ? (locale === "ar" ? product.nameAr : product.nameEn) : claim.productId,
        sku: product?.sku ?? "",
        value: costOf(claim.openQty, avgCost),
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);

  const totalOwed = rows.reduce((sum, r) => sum + r.value, 0);
  const currency = ctx.currency;
  // DataTable keys rows by `id`; claims are keyed by claim.
  const tableRows = rows.map((row) => ({ ...row, id: row.claimId }));
  type ClaimRow = (typeof tableRows)[number];
  const columns: Column<ClaimRow>[] = [
    {
      key: "product", header: t("claims.product"),
      render: (r) => (
        <>
          <div>{r.name}</div>
          <div className="text-xs text-muted">{r.sku}</div>
        </>
      ),
    },
    { key: "kind", header: t("claims.kind"), render: (r) => t(`claims.kind${r.kind}`) },
    { key: "assertedBy", header: t("claims.assertedBy"), render: (r) => t(`claims.by${r.assertedBy}`) },
    { key: "openQty", header: t("claims.openQty"), align: "end", render: (r) => <span className="tabular-nums">{formatQty(r.openQty, locale)}</span> },
    ...(canViewCost
      ? [{ key: "value", header: t("claims.value"), align: "end" as const, render: (r: ClaimRow) => <span className="tabular-nums">{formatMoney(r.value, locale, currency)}</span> }]
      : []),
    { key: "age", header: t("claims.age"), align: "end", render: (r) => <span className="tabular-nums">{formatNumber(r.ageDays, locale)}</span> },
    { key: "openedAt", header: t("claims.openedAt"), render: (r) => formatBusinessDate(r.openedAt, locale) },
  ];


  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("claims.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("claims.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="claims" />

      <OpenClaimForm
        products={allProducts.map((p) => ({
          id: p.id, name: locale === "ar" ? p.nameAr : p.nameEn,
        }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        kinds={[...CLAIM_KINDS]}
        labels={{
          openTitle: t("claims.openTitle"),
          product: t("claims.product"),
          warehouse: t("claims.warehouse"),
          kind: t("claims.kind"),
          quantity: t("claims.openQty"),
          notes: t("claims.notes"),
          open: t("claims.open"),
          opened: t("claims.opened"),
          generic: t("errors.generic"),
          kindRETURN: t("claims.kindRETURN"),
          kindDAMAGE: t("claims.kindDAMAGE"),
          kindSHORTAGE: t("claims.kindSHORTAGE"),
        }}
      />

      {rows.length === 0 ? (
        <EmptyState message={t("claims.empty")} />
      ) : (
        <>
          {canViewCost ? (
            <KpiCard label={t("claims.totalOwed")} value={formatMoney(totalOwed, locale, currency)} />
          ) : null}

          <DataTable columns={columns} rows={tableRows} empty={null} />
        </>
      )}
    </div>
  );
}

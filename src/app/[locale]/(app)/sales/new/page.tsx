import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { balancesForCompany } from "@/services/reporting";
import { ORDER_COST_TYPES, SALES_CHANNELS } from "@/lib/constants";
import { SaleForm, type SaleFormLabels } from "./SaleForm";

export default async function NewSalePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "sales.create", locale);
  const t = await getTranslator(locale);

  // The live profit summary needs a cost basis (avgCost) per product per
  // warehouse — CONSTRUCTED only when the role can see it, never merely
  // hidden by CSS: an ungated map here would sit in the RSC flight payload
  // where a role without finance.view_profit could read it straight from
  // devtools even with the summary section hidden on screen (same rule as
  // products/[id]/page.tsx's variantRows.avgCost gating).
  const canViewProfit = can(ctx.role, "finance.view_profit");
  const canPay = can(ctx.role, "payments.create");

  const [customers, warehouses, products, accounts, balances] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    prisma.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { nameEn: "asc" },
    }),
    canPay
      ? prisma.financialAccount.findMany({
          where: { companyId: ctx.companyId, status: "ACTIVE" },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    balancesForCompany(ctx.companyId),
  ]);

  // Available stock is a unit count, not cost data — shown regardless of
  // role (same as the products list' "available" column). The cost map
  // beside it IS cost data and is only built at all when canViewProfit.
  //
  // `balancesForCompany` sums availableQty ACROSS VARIANTS per product —
  // it is a display aggregate for "how much of this product is in this
  // warehouse", not a per-line stock check. That's the right source for
  // this preview today (no product on this form has variants; the line
  // table has no variant selector at all), but it would UNDER-count how
  // much a specific variant actually has once variant selection lands here,
  // since two variants' quantities would be shown summed as if either could
  // fully cover a line. The real, per-variant-aware enforcement already
  // lives where it must: `applyMovement` (via `confirmSale`) checks
  // `availableFor` against the exact `productId`+`variantId` pair being
  // sold and rejects with INSUFFICIENT_STOCK if short, regardless of what
  // this preview showed. If/when this form gains a variant selector, this
  // aggregate must be replaced with a variant-keyed lookup (or `availableFor`
  // itself) so the ON-SCREEN warning stays accurate per variant too — see
  // reporting.ts's own warning on `availableFor` being the only sanctioned
  // live-availability read.
  const stockByWarehouse: Record<string, Record<string, number>> = {};
  const costByWarehouse: Record<string, Record<string, number>> = {};
  for (const b of balances) {
    (stockByWarehouse[b.warehouseId] ??= {})[b.productId] = b.availableQty;
    if (canViewProfit) (costByWarehouse[b.warehouseId] ??= {})[b.productId] = b.avgCost;
  }

  const defaultWarehouse = warehouses.find((w) => w.isDefault) ?? warehouses[0];

  const channelOptions = Object.fromEntries(
    SALES_CHANNELS.map((c) => [c, t(`sales.channelOptions.${c}`)]),
  ) as SaleFormLabels["channelOptions"];
  const costTypeOptions = Object.fromEntries(
    ORDER_COST_TYPES.map((ct) => [ct, t(`sales.costTypeOptions.${ct}`)]),
  ) as SaleFormLabels["costTypeOptions"];

  const labels: SaleFormLabels = {
    customer: t("sales.customer"), customerSearchPlaceholder: t("sales.customerSearchPlaceholder"),
    walkIn: t("sales.walkIn"),
    warehouse: t("purchases.warehouse"), channel: t("sales.channel"), channelOptions,
    orderDate: t("purchases.orderDate"), notes: t("inventory.notes"),
    product: t("dashboard.product"), quantity: t("inventory.quantity"),
    unitPrice: t("purchases.unitPrice"), discount: t("purchases.discount"), tax: t("purchases.tax"),
    lineTotal: t("purchases.lineTotal"),
    availableStock: t("sales.availableStock"), stockWarningTemplate: t("sales.stockWarning"),
    addLine: t("inventory.addLine"), removeLine: t("inventory.removeLine"),
    orderCosts: t("sales.orderCosts"), costType: t("purchases.costType"),
    costDescription: t("purchases.costDescription"), costAmount: t("purchases.costAmount"),
    addCost: t("purchases.addCost"), removeCost: t("purchases.removeCost"), costTypeOptions,
    shippingCharged: t("sales.shippingCharged"), paidAmount: t("sales.paidAmount"), account: t("sales.account"),
    recordPayment: t("finance.recordPayment"),
    summary: t("purchases.summary"), subtotal: t("purchases.subtotal"),
    discountTotal: t("purchases.discountTotal"), taxTotal: t("purchases.taxTotal"),
    revenue: t("dashboard.revenue"), productCost: t("sales.productCost"),
    grossProfit: t("dashboard.grossProfit"), orderCostsTotal: t("sales.orderCosts"),
    netProfit: t("dashboard.netProfit"), margin: t("products.margin"),
    grandTotal: t("purchases.grandTotal"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("sales.createConfirmTitle"), confirmMessage: t("sales.createConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.NO_LINES": t("errors.NO_LINES"),
      "errors.TOO_MANY_LINES": t("errors.TOO_MANY_LINES"),
      "errors.INVALID_LINES": t("errors.INVALID_LINES"),
      "errors.QUANTITY_MUST_BE_POSITIVE": t("errors.QUANTITY_MUST_BE_POSITIVE"),
      "errors.INVALID_PRICE": t("errors.INVALID_PRICE"),
      "errors.INVALID_DISCOUNT": t("errors.INVALID_DISCOUNT"),
      "errors.INVALID_TAX_RATE": t("errors.INVALID_TAX_RATE"),
      "errors.INVALID_COST_AMOUNT": t("errors.INVALID_COST_AMOUNT"),
      "errors.INVALID_COST_TYPE": t("errors.INVALID_COST_TYPE"),
      "errors.INVALID_SHIPPING": t("errors.INVALID_SHIPPING"),
      "errors.INSUFFICIENT_STOCK": t("errors.INSUFFICIENT_STOCK"),
      "errors.ACCOUNT_REQUIRED": t("errors.ACCOUNT_REQUIRED"),
      "errors.PAYMENT_EXCEEDS_TOTAL": t("errors.PAYMENT_EXCEEDS_TOTAL"),
      "errors.INVALID_PAYMENT_AMOUNT": t("errors.INVALID_PAYMENT_AMOUNT"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("sales.add")}</h1>
      <SaleForm
        locale={locale}
        currency={ctx.currency}
        customers={customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        products={products.map((p) => ({
          id: p.id, nameAr: p.nameAr, nameEn: p.nameEn, sellingPrice: p.sellingPrice,
        }))}
        stockByWarehouse={stockByWarehouse}
        costByWarehouse={canViewProfit ? costByWarehouse : undefined}
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        canPay={canPay}
        defaultTaxRatePct={ctx.company.defaultTaxRatePct}
        defaultWarehouseId={defaultWarehouse?.id ?? ""}
        labels={labels}
      />
    </div>
  );
}

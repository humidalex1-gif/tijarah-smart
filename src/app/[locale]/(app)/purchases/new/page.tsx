import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { PURCHASE_COST_TYPES, ALLOCATION_METHODS } from "@/lib/constants";
import { PurchaseOrderForm, type PurchaseOrderFormLabels } from "./PurchaseOrderForm";

export default async function NewPurchaseOrderPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "purchases.create", locale);
  const t = await getTranslator(locale);

  const [suppliers, warehouses, products] = await Promise.all([
    prisma.supplier.findMany({
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
  ]);

  // purchasePrice (below, passed to a "use client" form purely to prefill a
  // new line's unit cost) is cost data, but this page needs no separate
  // finance.view_cost gate: `purchases.create` is only ever granted to
  // OWNER/ADMIN in the fixed Stage 1 role matrix (src/lib/permissions.ts),
  // both of which hold "*" and therefore finance.view_cost too. Unlike the
  // list/detail pages (which VIEWER/SALES_EMPLOYEE-adjacent roles CAN reach),
  // there is no role that can open this page without also being allowed to
  // see cost.

  // Every allocation method the form can offer maps to a dictionary label —
  // MANUAL is deliberately excluded from ALLOCATION_METHODS here (the form's
  // <select> and its Zod schema both stop at QUANTITY|VALUE|WEIGHT|EQUAL;
  // createPurchaseOrder rejects MANUAL with MANUAL_ALLOCATION_NOT_SUPPORTED).
  const allocationOptions = Object.fromEntries(
    ALLOCATION_METHODS.filter((m) => m !== "MANUAL").map((m) => [m, t(`purchases.allocationOptions.${m}`)]),
  ) as PurchaseOrderFormLabels["allocationOptions"];
  const costTypeOptions = Object.fromEntries(
    PURCHASE_COST_TYPES.map((ct) => [ct, t(`purchases.costTypeOptions.${ct}`)]),
  ) as PurchaseOrderFormLabels["costTypeOptions"];

  const labels: PurchaseOrderFormLabels = {
    supplier: t("purchases.supplier"), warehouse: t("purchases.warehouse"),
    orderDate: t("purchases.orderDate"), expectedDate: t("purchases.expectedDate"),
    allocationMethod: t("purchases.allocationMethod"), notes: t("inventory.notes"),
    product: t("dashboard.product"), quantity: t("inventory.quantity"),
    unitPrice: t("purchases.unitPrice"), discount: t("purchases.discount"), tax: t("purchases.tax"),
    lineTotal: t("purchases.lineTotal"),
    addLine: t("inventory.addLine"), removeLine: t("inventory.removeLine"),
    costType: t("purchases.costType"), costDescription: t("purchases.costDescription"),
    costAmount: t("purchases.costAmount"), addCost: t("purchases.addCost"), removeCost: t("purchases.removeCost"),
    summary: t("purchases.summary"), subtotal: t("purchases.subtotal"),
    discountTotal: t("purchases.discountTotal"), taxTotal: t("purchases.taxTotal"),
    additionalCostTotal: t("purchases.additionalCostTotal"), grandTotal: t("purchases.grandTotal"),
    projectedLandedCost: t("purchases.projectedLandedCost"), landedCostHint: t("purchases.landedCostHint"),
    allocationOptions, costTypeOptions,
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("purchases.createConfirmTitle"),
    confirmMessageTemplate: t("purchases.createConfirmMessage"),
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
      "errors.INVALID_ALLOCATION_METHOD": t("errors.INVALID_ALLOCATION_METHOD"),
      "errors.MANUAL_ALLOCATION_NOT_SUPPORTED": t("errors.MANUAL_ALLOCATION_NOT_SUPPORTED"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("purchases.add")}</h1>
      <PurchaseOrderForm
        locale={locale}
        currency={ctx.currency}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        products={products.map((p) => ({
          id: p.id, nameAr: p.nameAr, nameEn: p.nameEn,
          weightGrams: p.weightGrams, purchasePrice: p.purchasePrice,
        }))}
        defaultTaxRatePct={ctx.company.defaultTaxRatePct}
        labels={labels}
      />
    </div>
  );
}

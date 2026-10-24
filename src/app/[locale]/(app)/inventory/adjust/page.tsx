import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { AdjustForm, type AdjustFormLabels } from "./AdjustForm";

export default async function AdjustStockPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.adjust", locale);
  const t = await getTranslator(locale);

  const [warehouses, products] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
  ]);

  const labels: AdjustFormLabels = {
    warehouse: t("inventory.warehouse"), product: t("dashboard.product"),
    systemQty: t("inventory.systemQty"), countedQty: t("inventory.countedQty"),
    difference: t("inventory.difference"), reason: t("inventory.reason"), notes: t("inventory.notes"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("inventory.adjustConfirmTitle"),
    confirmMessageTemplate: t("inventory.adjustConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.REASON_REQUIRED": t("errors.REASON_REQUIRED"),
      "errors.INVALID_QUANTITY": t("errors.INVALID_QUANTITY"),
      "errors.INSUFFICIENT_STOCK": t("errors.INSUFFICIENT_STOCK"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("inventory.adjust")}</h1>
      <AdjustForm
        locale={locale}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        products={products.map((p) => ({ id: p.id, nameAr: p.nameAr, nameEn: p.nameEn }))}
        labels={labels}
      />
    </div>
  );
}

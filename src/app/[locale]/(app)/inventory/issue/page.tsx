import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { IssueForm, type IssueFormLabels } from "./IssueForm";

export default async function IssueStockPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.issue", locale);
  const t = await getTranslator(locale);

  const [warehouses, products] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
  ]);

  const labels: IssueFormLabels = {
    warehouse: t("inventory.warehouse"), product: t("dashboard.product"),
    quantity: t("inventory.quantity"), reason: t("inventory.reason"), notes: t("inventory.notes"),
    available: t("products.available"), save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("inventory.issueConfirmTitle"),
    confirmMessageTemplate: t("inventory.issueConfirmMessage"),
    insufficientTemplate: t("inventory.insufficient"),
    reasonLabels: {
      INTERNAL_USE: t("movement.INTERNAL_USE"),
      PROMOTIONAL_USE: t("movement.PROMOTIONAL_USE"),
      DAMAGED: t("movement.DAMAGED"),
      LOST: t("movement.LOST"),
    },
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.QUANTITY_MUST_BE_POSITIVE": t("errors.QUANTITY_MUST_BE_POSITIVE"),
      "errors.INVALID_QUANTITY": t("errors.INVALID_QUANTITY"),
      "errors.INVALID_ISSUE_REASON": t("errors.INVALID_ISSUE_REASON"),
      "errors.INSUFFICIENT_STOCK": t("errors.INSUFFICIENT_STOCK"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("inventory.issue")}</h1>
      <IssueForm
        locale={locale}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        products={products.map((p) => ({ id: p.id, nameAr: p.nameAr, nameEn: p.nameEn }))}
        labels={labels}
      />
    </div>
  );
}

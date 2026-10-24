import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { TransferForm, type TransferFormLabels } from "./TransferForm";

export default async function CreateTransferPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.transfer", locale);
  const t = await getTranslator(locale);

  const [warehouses, products] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
  ]);

  const labels: TransferFormLabels = {
    source: t("inventory.from"), destination: t("inventory.to"), product: t("dashboard.product"),
    quantity: t("inventory.quantity"), available: t("products.available"), notes: t("inventory.notes"),
    addLine: t("inventory.addLine"), removeLine: t("inventory.removeLine"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("inventory.transferConfirmTitle"),
    confirmMessageTemplate: t("inventory.transferConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.SAME_WAREHOUSE": t("errors.SAME_WAREHOUSE"),
      "errors.NO_LINES": t("errors.NO_LINES"),
      "errors.QUANTITY_MUST_BE_POSITIVE": t("errors.QUANTITY_MUST_BE_POSITIVE"),
      "errors.INSUFFICIENT_STOCK": t("errors.INSUFFICIENT_STOCK"),
      "errors.INVALID_LINES": t("errors.INVALID_LINES"),
      "errors.TOO_MANY_LINES": t("errors.TOO_MANY_LINES"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("inventory.transfer")}</h1>
      <TransferForm
        locale={locale}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        products={products.map((p) => ({ id: p.id, nameAr: p.nameAr, nameEn: p.nameEn }))}
        labels={labels}
      />
    </div>
  );
}

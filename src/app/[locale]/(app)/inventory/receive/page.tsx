import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { ReceiveForm, type ReceiveFormLabels } from "./ReceiveForm";

export default async function ReceiveStockPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.receive", locale);
  const t = await getTranslator(locale);

  const [warehouses, products] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
  ]);

  const labels: ReceiveFormLabels = {
    warehouse: t("inventory.warehouse"), product: t("dashboard.product"),
    quantity: t("inventory.quantity"), unitCost: t("inventory.unitCost"), notes: t("inventory.notes"),
    available: t("products.available"), save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("inventory.receiveConfirmTitle"),
    // Deliberately called with NO vars: `t()` then returns the raw
    // "{qty}"/"{product}"/"{warehouse}" template unfilled, which the client
    // component substitutes itself once the merchant has actually typed
    // values — see `fillTemplate`'s doc comment in src/lib/i18n.ts for why a
    // `Translator` closure can't just be handed to the client directly.
    confirmMessageTemplate: t("inventory.receiveConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.QUANTITY_MUST_BE_POSITIVE": t("errors.QUANTITY_MUST_BE_POSITIVE"),
      "errors.INVALID_QUANTITY": t("errors.INVALID_QUANTITY"),
      "errors.INVALID_AMOUNT": t("errors.INVALID_AMOUNT"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("inventory.receive")}</h1>
      <ReceiveForm
        locale={locale}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        products={products.map((p) => ({ id: p.id, nameAr: p.nameAr, nameEn: p.nameEn }))}
        labels={labels}
      />
    </div>
  );
}

import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { NewCountForm, type NewCountFormLabels } from "./NewCountForm";

export default async function NewStockCountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.count", locale);
  const t = await getTranslator(locale);

  const [warehouses, categories, brands] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.productCategory.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { nameEn: "asc" },
    }),
    prisma.brand.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  const labels: NewCountFormLabels = {
    warehouse: t("counts.warehouse"), scope: t("counts.scope"),
    scopeWarehouse: t("counts.scopeWarehouse"),
    scopeCategory: t("counts.scopeCategory"),
    scopeBrand: t("counts.scopeBrand"),
    category: t("products.category"), brand: t("products.brand"),
    notes: t("inventory.notes"),
    save: t("app.save"), cancel: t("app.cancel"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.COUNT_EMPTY_SCOPE": t("errors.COUNT_EMPTY_SCOPE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("counts.add")}</h1>
      <NewCountForm
        locale={locale}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        categories={categories.map((c) => ({ id: c.id, nameAr: c.nameAr, nameEn: c.nameEn }))}
        brands={brands.map((b) => ({ id: b.id, name: b.name }))}
        labels={labels}
      />
    </div>
  );
}

import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { WarehouseForm, type WarehouseFormLabels } from "../WarehouseForm";

export default async function NewWarehousePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "warehouses.create", locale);
  const t = await getTranslator(locale);

  const labels: WarehouseFormLabels = {
    name: t("warehouses.name"), code: t("warehouses.code"), city: t("warehouses.city"),
    isDefault: t("warehouses.isDefault"),
    save: t("app.save"), cancel: t("app.cancel"),
    duplicateCode: t("warehouses.duplicateCode"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.DUPLICATE_WAREHOUSE_CODE": t("errors.DUPLICATE_WAREHOUSE_CODE"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("warehouses.add")}</h1>
      <WarehouseForm
        locale={locale}
        mode="create"
        defaults={{ name: "", code: "", city: "", isDefault: false }}
        labels={labels}
      />
    </div>
  );
}

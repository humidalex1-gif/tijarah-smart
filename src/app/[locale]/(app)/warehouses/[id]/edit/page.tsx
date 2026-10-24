import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { WarehouseForm, type WarehouseFormLabels } from "../../WarehouseForm";

export default async function EditWarehousePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "warehouses.edit", locale);
  const t = await getTranslator(locale);

  const warehouse = await prisma.warehouse.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!warehouse) notFound();

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
      "errors.LAST_DEFAULT_WAREHOUSE": t("errors.LAST_DEFAULT_WAREHOUSE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("app.edit")}: {warehouse.name}</h1>
      <WarehouseForm
        locale={locale}
        mode="edit"
        warehouseId={warehouse.id}
        defaults={{
          name: warehouse.name, code: warehouse.code, city: warehouse.city ?? "",
          isDefault: warehouse.isDefault,
        }}
        labels={labels}
      />
    </div>
  );
}

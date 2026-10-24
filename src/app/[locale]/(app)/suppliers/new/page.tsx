import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { SupplierForm, type SupplierFormLabels } from "../SupplierForm";

export default async function NewSupplierPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "suppliers.create", locale);
  const t = await getTranslator(locale);

  const labels: SupplierFormLabels = {
    name: t("suppliers.name"), companyName: t("suppliers.companyName"),
    contactPerson: t("suppliers.contactPerson"), phone: t("suppliers.phone"), email: t("suppliers.email"),
    country: t("suppliers.country"), city: t("suppliers.city"), address: t("suppliers.address"),
    taxNumber: t("suppliers.taxNumber"), paymentTermsDays: t("suppliers.paymentTermsDays"),
    notes: t("suppliers.notes"),
    save: t("app.save"), cancel: t("app.cancel"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.INVALID_NAME": t("errors.INVALID_NAME"),
      "errors.INVALID_PAYMENT_TERMS": t("errors.INVALID_PAYMENT_TERMS"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("suppliers.add")}</h1>
      <SupplierForm
        locale={locale}
        mode="create"
        defaults={{
          name: "", companyName: "", contactPerson: "", phone: "", email: "",
          country: "", city: "", address: "", taxNumber: "", paymentTermsDays: "0", notes: "",
        }}
        labels={labels}
      />
    </div>
  );
}

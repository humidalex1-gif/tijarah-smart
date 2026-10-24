import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { CUSTOMER_TYPES } from "@/lib/constants";
import { CustomerForm, type CustomerFormLabels } from "../CustomerForm";

export default async function NewCustomerPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "customers.create", locale);
  const t = await getTranslator(locale);

  const typeOptions = Object.fromEntries(
    CUSTOMER_TYPES.map((c) => [c, t(`customers.${c.toLowerCase()}`)]),
  ) as CustomerFormLabels["typeOptions"];

  const labels: CustomerFormLabels = {
    customerType: t("customers.type"), typeOptions,
    name: t("suppliers.name"), phone: t("suppliers.phone"), email: t("suppliers.email"),
    country: t("suppliers.country"), city: t("suppliers.city"), address: t("suppliers.address"),
    taxNumber: t("suppliers.taxNumber"), creditLimit: t("customers.creditLimit"),
    paymentTermsDays: t("suppliers.paymentTermsDays"), notes: t("suppliers.notes"),
    save: t("app.save"), cancel: t("app.cancel"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.INVALID_NAME": t("errors.INVALID_NAME"),
      "errors.INVALID_CUSTOMER_TYPE": t("errors.INVALID_CUSTOMER_TYPE"),
      "errors.INVALID_PAYMENT_TERMS": t("errors.INVALID_PAYMENT_TERMS"),
      "errors.INVALID_CREDIT_LIMIT": t("errors.INVALID_CREDIT_LIMIT"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("customers.add")}</h1>
      <CustomerForm
        locale={locale}
        mode="create"
        defaults={{
          customerType: "RETAIL", name: "", phone: "", email: "",
          country: "", city: "", address: "", taxNumber: "",
          creditLimit: "0", paymentTermsDays: "0", notes: "",
        }}
        labels={labels}
      />
    </div>
  );
}

import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { can } from "@/lib/permissions";
import { hasFinancialActivity } from "@/services/company";
import { CompanySettingsForm, type CompanySettingsFormLabels } from "./CompanySettingsForm";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "settings.view", locale);
  const t = await getTranslator(locale);

  const canEdit = can(ctx.role, "settings.edit");
  const canManageUsers = can(ctx.role, "users.manage");
  // Same predicate updateCompanySettings itself enforces (src/services/
  // company.ts) — computed here so the currency field can be disabled with
  // an explanatory hint before the merchant even attempts a change the
  // server would reject anyway. Only run for a role that can actually edit
  // (four extra queries otherwise) — a VIEWER/etc. already gets the whole
  // form disabled via `canEdit`, so the currency-specific lock state is
  // moot for them regardless of its true value.
  const currencyLocked = canEdit ? await hasFinancialActivity(ctx.companyId) : false;

  const labels: CompanySettingsFormLabels = {
    name: t("suppliers.name"), legalName: t("settings.legalName"), phone: t("suppliers.phone"),
    email: t("suppliers.email"), address: t("suppliers.address"), taxNumber: t("suppliers.taxNumber"),
    currency: t("onboarding.currency"), defaultTaxRate: t("onboarding.taxRate"), timezone: t("settings.timezone"),
    timezoneHint: t("settings.timezoneHint"), currencyLockedHint: t("settings.currencyLockedHint"),
    negativeInventory: t("settings.negativeInventory"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    saveConfirmTitle: t("settings.saveConfirmTitle"), saveConfirmMessage: t("settings.saveConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.INVALID_TAX_RATE": t("errors.INVALID_TAX_RATE"),
      "errors.CURRENCY_LOCKED": t("errors.CURRENCY_LOCKED"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  const defaults = {
    name: ctx.company.name,
    legalName: ctx.company.legalName ?? "",
    phone: ctx.company.phone ?? "",
    email: ctx.company.email ?? "",
    address: ctx.company.address ?? "",
    taxNumber: ctx.company.taxNumber ?? "",
    currencyCode: ctx.company.currencyCode,
    defaultTaxRatePct: String(ctx.company.defaultTaxRatePct / 100),
    timezone: ctx.company.timezone,
    allowNegativeInventory: ctx.company.allowNegativeInventory,
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-navy">{t("settings.company")}</h1>

        <div className="flex flex-wrap gap-2">
          {canEdit ? (
            <Link
              href={`/${locale}/settings/fasthub`}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-navy hover:bg-surface"
            >
              {t("fasthub.title")}
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              href={`/${locale}/settings/salla`}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-navy hover:bg-surface"
            >
              {t("salla.title")}
            </Link>
          ) : null}
          {canManageUsers ? (
            <Link
              href={`/${locale}/settings/team`}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-navy hover:bg-surface"
            >
              {t("settings.manageTeam")}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="mb-6">
        <PageHelp t={t} pageKey="settings" />
      </div>

      <CompanySettingsForm defaults={defaults} canEdit={canEdit} currencyLocked={currencyLocked} labels={labels} />
    </div>
  );
}

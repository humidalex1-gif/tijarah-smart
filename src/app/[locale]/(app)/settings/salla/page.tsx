import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { formatBusinessDate } from "@/lib/format";
import { getConnectionStatus } from "@/services/salla/connection";
import { can } from "@/lib/permissions";
import { SallaConnectionForm } from "./SallaConnectionForm";
import { SallaCostReport, type SallaCostReportLabels } from "./SallaCostReport";

/**
 * Where the owner links the store, so credentials never have to be typed into
 * a file. Everything sensitive stays server-side: `getConnectionStatus` carries
 * the client id and booleans, never the secret or either token.
 */
export default async function SallaSettingsPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "settings.edit", locale);
  const t = await getTranslator(locale);

  const status = await getConnectionStatus(ctx.companyId);

  // The panel below renders cost figures, which every other screen in this app
  // gates on `finance.view_cost`. Its action gates on the same permission, so
  // hiding it here is not the security boundary — it is not offering a button
  // that would refuse.
  const canViewCost = can(ctx.role, "finance.view_cost");
  const costLabels: SallaCostReportLabels | null = canViewCost
    ? {
      title: t("salla.costs.title"), intro: t("salla.costs.intro"),
      read: t("salla.costs.read"), reading: t("salla.costs.reading"),
      sku: t("salla.costs.sku"), ourCost: t("salla.costs.ourCost"),
      theirCost: t("salla.costs.theirCost"), state: t("salla.costs.state"),
      repairableTitle: t("salla.costs.repairableTitle"),
      commandHint: t("salla.costs.commandHint"),
      noneTitle: t("salla.costs.noneTitle"),
      summaryTemplate: t("salla.costs.summaryTemplate"),
      status: {
        REPAIRABLE: t("salla.costs.status.REPAIRABLE"),
        ALREADY_COSTED: t("salla.costs.status.ALREADY_COSTED"),
        SALLA_HAS_NO_COST: t("salla.costs.status.SALLA_HAS_NO_COST"),
        UNSOLD_COST_AVAILABLE: t("salla.costs.status.UNSOLD_COST_AVAILABLE"),
        NOT_IN_SALLA: t("salla.costs.status.NOT_IN_SALLA"),
        AMBIGUOUS_IN_SALLA: t("salla.costs.status.AMBIGUOUS_IN_SALLA"),
      },
      errors: {
        "errors.generic": t("errors.generic"),
        "errors.SALLA_NOT_CONNECTED": t("errors.SALLA_NOT_CONNECTED"),
        "errors.SALLA_NOT_CONFIGURED": t("errors.SALLA_NOT_CONFIGURED"),
        "errors.SALLA_REQUEST_FAILED": t("errors.SALLA_REQUEST_FAILED"),
        "errors.SALLA_RATE_LIMITED": t("errors.SALLA_RATE_LIMITED"),
        "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      },
    }
    : null;

  // The OAuth callback can only hand back a flag — an error detail in that URL
  // would land in browser history and in any screenshot sent for help.
  const justConnected = sp.connected === "1";
  const justFailed = sp.error === "1";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("salla.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("salla.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="salla" />

      {justConnected ? (
        <p className="rounded-lg bg-success-soft p-3 text-sm text-success">{t("salla.connected")}</p>
      ) : null}
      {justFailed ? (
        <p className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{t("salla.failed")}</p>
      ) : null}

      <SallaConnectionForm
        status={status}
        connectedAtLabel={
          status.connectedAt ? formatBusinessDate(status.connectedAt, locale) : null
        }
        labels={{
          clientId: t("salla.clientId"),
          clientSecret: t("salla.clientSecret"),
          secretStored: t("salla.secretStored"),
          save: t("salla.save"),
          saved: t("salla.saved"),
          connect: t("salla.connect"),
          connectHint: t("salla.connectHint"),
          disconnect: t("salla.disconnect"),
          disconnected: t("salla.disconnected"),
          notConnected: t("salla.notConnected"),
          storeName: t("salla.storeName"),
          connectedAt: t("salla.connectedAt"),
          scopes: t("salla.scopes"),
          accessValid: t("salla.accessValid"),
          accessExpired: t("salla.accessExpired"),
          generic: t("errors.generic"),
        }}
      />

      {/* Only once the store is actually linked: the read needs a live
          authorisation, and a button that can only fail is worse than none. */}
      {costLabels && status.connected ? (
        <SallaCostReport locale={locale} currency={ctx.currency} labels={costLabels} />
      ) : null}
    </div>
  );
}

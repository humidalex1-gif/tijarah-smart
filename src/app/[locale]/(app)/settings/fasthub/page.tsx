import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { formatBusinessDate } from "@/lib/format";
import { getFastHubStatus } from "@/services/fasthub/connection";
import { recentSyncRuns } from "@/services/fasthub/syncRun";
import { FastHubConnectionForm } from "./FastHubConnectionForm";
import { SyncPanel } from "./SyncPanel";
import { SyncHistory } from "./SyncHistory";

/**
 * Where the owner pastes the Fast Hub credentials.
 *
 * Everything sensitive stays server-side: `getFastHubStatus` carries the client
 * id, some booleans and some dates, and none of the four secrets.
 */
export default async function FastHubSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "settings.edit", locale);
  const t = await getTranslator(locale);

  const status = await getFastHubStatus(ctx.companyId);
  const runs = await recentSyncRuns(ctx.companyId);
  const on = (value: Date | null) => (value ? formatBusinessDate(value, locale) : null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("fasthub.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("fasthub.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="fasthub" />

      <FastHubConnectionForm
        status={status}
        dates={{
          accessExpires: on(status.accessExpiresAt),
          refreshExpires: on(status.refreshExpiresAt),
          lastPolled: on(status.lastPolledAt),
        }}
        labels={{
          clientId: t("fasthub.clientId"),
          clientSecret: t("fasthub.clientSecret"),
          accessToken: t("fasthub.accessToken"),
          refreshToken: t("fasthub.refreshToken"),
          webhookSecret: t("fasthub.webhookSecret"),
          optional: t("fasthub.optional"),
          stored: t("fasthub.stored"),
          save: t("fasthub.save"),
          saved: t("fasthub.saved"),
          disconnect: t("fasthub.disconnect"),
          disconnected: t("fasthub.disconnected"),
          notConnected: t("fasthub.notConnected"),
          connected: t("fasthub.connected"),
          accessExpires: t("fasthub.accessExpires"),
          refreshExpires: t("fasthub.refreshExpires"),
          lastPolled: t("fasthub.lastPolled"),
          never: t("fasthub.never"),
          accessValid: t("fasthub.accessValid"),
          accessExpired: t("fasthub.accessExpired"),
          whereFrom: t("fasthub.whereFrom"),
          generic: t("errors.generic"),
        }}
      />

      <SyncPanel
        // Nothing to poll with until the tokens are stored; the button would
        // only ever produce an error the owner cannot act on.
        disabled={!status.connected}
        labels={{
          syncNow: t("fasthub.syncNow"),
          syncing: t("fasthub.syncing"),
          syncDone: t("fasthub.syncDone"),
          syncOrdersCreated: t("fasthub.syncOrdersCreated"),
          syncClaimsOpened: t("fasthub.syncClaimsOpened"),
          syncSettledSellable: t("fasthub.syncSettledSellable"),
          syncSettledDamaged: t("fasthub.syncSettledDamaged"),
          syncUnknownSkus: t("fasthub.syncUnknownSkus"),
          syncQcMissing: t("fasthub.syncQcMissing"),
          syncFailures: t("fasthub.syncFailures"),
          syncDiffs: t("fasthub.syncDiffs"),
          syncNoChanges: t("fasthub.syncNoChanges"),
          syncOrdersFailed: t("fasthub.syncOrdersFailed"),
          syncPreOpening: t("fasthub.syncPreOpening"),
          generic: t("errors.generic"),
        }}
        errors={{
          "errors.FORBIDDEN": t("errors.FORBIDDEN"),
          "errors.FASTHUB_NOT_CONFIGURED": t("errors.FASTHUB_NOT_CONFIGURED"),
          "errors.FASTHUB_NOT_CONNECTED": t("errors.FASTHUB_NOT_CONNECTED"),
          "errors.FASTHUB_TOKEN_EXPIRED": t("errors.FASTHUB_TOKEN_EXPIRED"),
          "errors.FASTHUB_REQUEST_FAILED": t("errors.FASTHUB_REQUEST_FAILED"),
          "errors.FASTHUB_RATE_LIMITED": t("errors.FASTHUB_RATE_LIMITED"),
        }}
      />

      <SyncHistory runs={runs} locale={locale} t={t} />
    </div>
  );
}

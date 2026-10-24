import type { Locale, Translator } from "@/lib/i18n";
import { formatBusinessDateTime, formatNumber } from "@/lib/format";
import type { SyncRunView } from "@/services/fasthub/syncRun";

/**
 * Every run the poller has made, healthy ones included.
 *
 * The healthy rows are the point. A screen that only lists problems cannot
 * tell "nothing went wrong" apart from "the timer stopped a week ago", and the
 * second of those is the failure that hides every other one.
 */
export function SyncHistory({
  runs, locale, t,
}: {
  runs: SyncRunView[];
  locale: Locale;
  t: Translator;
}) {
  const n = (value: number) => formatNumber(value, locale);

  const TONE: Record<string, string> = {
    OK: "bg-success-soft text-success",
    ATTENTION: "bg-warning-soft text-warning",
    FAILED: "bg-danger-soft text-danger",
  };

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold">{t("sync.historyTitle")}</h2>
      <p className="mt-1 text-xs text-muted">{t("sync.historyIntro")}</p>

      {runs.length === 0 ? (
        // Not "no results" — this specific emptiness means the automatic poll
        // has never completed, which is itself the thing to act on.
        <p className="mt-4 rounded-lg border border-warning bg-warning-soft p-3 text-sm text-navy">
          {t("sync.neverRun")}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {runs.map((run) => {
            const items = [
              ...run.attention.failedResources.map((r) => `${t("sync.alertFailedResources")}: ${t(`sync.resource.${r}`)}`),
              ...run.attention.unknownSkus.map((s) => `${t("sync.alertUnknownSkus")}: ${s}`),
              ...run.attention.preOpening.map((o) => `${t("sync.alertPreOpening")}: ${o}`),
              ...run.attention.failedOrders.map((o) => `${t("sync.alertFailedOrders")}: ${o}`),
              ...run.attention.qcSplitMissing.map((r) => `${t("sync.alertQcMissing")}: ${r}`),
              ...run.attention.differences.map(
                (d) => `${t("sync.alertDifferences")}: ${d.sku} — ${t("sync.warehouse")} ${n(d.fastHub)} / ${t("sync.books")} ${n(d.books)}`,
              ),
            ];

            return (
              <li key={run.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-[0.6875rem] font-medium ${TONE[run.outcome] ?? ""}`}>
                      {t(`sync.outcome.${run.outcome}`)}
                    </span>
                    <span className="text-sm text-navy">
                      {formatBusinessDateTime(run.startedAt, locale)}
                    </span>
                    <span className="text-xs text-muted">{t(`sync.trigger.${run.trigger}`)}</span>
                  </div>
                  <span className="text-xs text-muted">
                    {t("sync.ordersCreated")} {n(run.ordersCreated)} · {t("sync.claimsOpened")} {n(run.claimsOpened)} · {t("sync.diffCount")} {n(run.diffCount)}
                  </span>
                </div>

                {items.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {items.map((item) => (
                      <li key={item} className="text-sm text-muted">{item}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

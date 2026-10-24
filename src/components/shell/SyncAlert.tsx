import Link from "next/link";
import type { Locale, Translator } from "@/lib/i18n";
import { formatBusinessDateTime, formatNumber } from "@/lib/format";
import type { SyncRunView } from "@/services/fasthub/syncRun";
import type { DifferenceExplanation } from "@/services/fasthub/explainDifferences";
import { SyncNowButton } from "./SyncNowButton";

/**
 * What the unattended sync found, on the screen the owner actually opens.
 *
 * The poll runs hourly against Fast Hub and reports into the systemd journal.
 * Everything it refuses to guess at — an unknown SKU, an order older than the
 * opening balance, an order that threw, a warehouse figure that disagrees with
 * the books — was therefore invisible. This is the other half of those loud
 * failure modes: loud only counts if someone hears it.
 *
 * Renders nothing when there is nothing to say. The "the sync is healthy"
 * signal belongs on the Fast Hub settings screen next to the run history,
 * where "quiet" can be told apart from "not running"; a dashboard banner
 * saying "all fine" every day trains the owner to stop reading banners.
 */
export function SyncAlert({
  runs, locale, t, acknowledge, explanations = {},
}: {
  runs: SyncRunView[];
  locale: Locale;
  t: Translator;
  acknowledge: (formData: FormData) => Promise<void>;
  /** The reconcile preview's reading of each difference, by SKU. */
  explanations?: Record<string, DifferenceExplanation>;
}) {
  if (runs.length === 0) return null;

  const failed = runs.some((run) => run.outcome === "FAILED");
  const latest = runs[0];

  // Merged across every unacknowledged run: the same unknown SKU appearing in
  // twelve hourly polls is one problem, not twelve.
  const unknownSkus = [...new Set(runs.flatMap((r) => r.attention.unknownSkus))];
  const preOpening = [...new Set(runs.flatMap((r) => r.attention.preOpening))];
  const failedOrders = [...new Set(runs.flatMap((r) => r.attention.failedOrders))];
  const draftsUnreadable = [...new Set(runs.flatMap((r) => r.attention.draftsUnreadable))];
  const cancelledAfterConfirm = [...new Set(runs.flatMap((r) => r.attention.cancelledAfterConfirm ?? []))];
  const qcSplitMissing = [...new Set(runs.flatMap((r) => r.attention.qcSplitMissing))];
  const failedResources = [...new Set(runs.flatMap((r) => r.attention.failedResources))];
  const differences = latest.attention.differences;

  const lines: { label: string; value: string }[] = [];
  const add = (label: string, values: string[]) => {
    if (values.length > 0) lines.push({ label, value: values.join("، ") });
  };
  add(t("sync.alertFailedResources"), failedResources.map((r) => t(`sync.resource.${r}`)));
  add(t("sync.alertUnknownSkus"), unknownSkus);
  add(t("sync.alertPreOpening"), preOpening);
  add(t("sync.alertFailedOrders"), failedOrders);
  add(t("sync.alertDraftsUnreadable"), draftsUnreadable);
  add(t("sync.alertCancelledAfterConfirm"), cancelledAfterConfirm);
  add(t("sync.alertQcMissing"), qcSplitMissing);
  /**
   * Sorted by the difference, descending, which separates the two KINDS of
   * disagreement without needing a heading for each: a surplus is stock that
   * arrived and needs a purchase entry, a shortfall is possible loss for the
   * reconciliation. Nine of them joined into one comma-separated sentence —
   * the shape this replaced — read as one undifferentiated mess.
   */
  const rankedDifferences = [...differences]
    .map((d) => ({ ...d, delta: d.fastHub - d.books }))
    .sort((a, b) => b.delta - a.delta);

  /**
   * The two totals the table adds up to. Fourteen rows are a list of symptoms;
   * "this many units are sitting at the warehouse unrecorded" and "this many
   * the books cannot account for" are the two separate jobs they amount to,
   * and adding the last column up by eye is not reading.
   */
  const surplus = rankedDifferences.filter((d) => d.delta > 0);
  const shortfall = rankedDifferences.filter((d) => d.delta < 0);
  const totalUnits = (rows: typeof rankedDifferences) =>
    formatNumber(rows.reduce((total, d) => total + Math.abs(d.delta), 0), locale);

  /**
   * The cause beside the figure. "warehouse 90 / books 91" left the owner to
   * guess whether the unit was a return still in the post, a damage not yet
   * split out, or stock genuinely gone; the reconcile preview knows, and
   * this is its reading. A SKU without one gets a dash, never a number.
   */
  const explain = (sku: string): string => {
    const e = explanations[sku];
    if (!e) return "—";
    if (!e.determinate) return t("sync.explain.indeterminate");
    const parts: string[] = [];
    const add = (key: string, n: number) => {
      if (n > 0) parts.push(`${t(key)} ${formatNumber(n, locale)}`);
    };
    add("sync.explain.claims", e.settleable);
    add("sync.explain.stillClaimed", e.stillClaimed);
    add("sync.explain.unexplained", e.unexplained);
    add("sync.explain.surplus", e.surplus);
    return parts.length > 0 ? parts.join(" · ") : t("sync.explain.none");
  };

  const toneBorder = failed ? "border-danger" : "border-warning";
  // Also the scroll container's sticky header fill below: rows have to scroll
  // UNDER the header, not through it, and only a solid background does that.
  const toneFill = failed ? "bg-danger-soft" : "bg-warning-soft";

  return (
    <section
      // Not `role="alert"`: this is server-rendered on page load, not an
      // interruption, and an assertive live region would talk over the reader
      // every navigation.
      aria-labelledby="sync-alert-title"
      className={`mb-6 rounded-xl border p-4 ${toneBorder} ${toneFill}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="sync-alert-title" className="text-sm font-semibold text-navy">
            {failed ? t("sync.alertFailedTitle") : t("sync.alertTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t("sync.alertWhen")} {formatBusinessDateTime(latest.startedAt, locale)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {/* Every key it can be handed, translated here: the button is a
              Client Component and `t` cannot cross that boundary. */}
          <SyncNowButton
            labels={{
              syncNow: t("fasthub.syncNow"),
              syncing: t("fasthub.syncing"),
              done: t("fasthub.syncDone"),
              generic: t("errors.generic"),
              errors: {
                "errors.FORBIDDEN": t("errors.FORBIDDEN"),
                "errors.FASTHUB_NOT_CONFIGURED": t("errors.FASTHUB_NOT_CONFIGURED"),
                "errors.FASTHUB_NOT_CONNECTED": t("errors.FASTHUB_NOT_CONNECTED"),
                "errors.FASTHUB_TOKEN_EXPIRED": t("errors.FASTHUB_TOKEN_EXPIRED"),
                "errors.FASTHUB_REQUEST_FAILED": t("errors.FASTHUB_REQUEST_FAILED"),
                "errors.FASTHUB_RATE_LIMITED": t("errors.FASTHUB_RATE_LIMITED"),
              },
            }}
          />
          <Link
            href={`/${locale}/settings/fasthub`}
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface"
          >
            {t("sync.alertOpen")}
          </Link>
          {/* Dismisses the banner, never the record. The run rows stay so the
              history of what the sync found survives being read. */}
          <form action={acknowledge}>
            <button type="submit" className="text-sm text-muted hover:text-navy">
              {t("sync.alertDismiss")}
            </button>
          </form>
        </div>
      </div>

      <dl className="mt-3 space-y-1.5">
        {lines.map((line) => (
          <div key={line.label} className="flex flex-wrap gap-x-2 text-sm leading-relaxed">
            <dt className="text-muted">{line.label}:</dt>
            <dd className="min-w-0 break-words font-medium text-navy">{line.value}</dd>
          </div>
        ))}
      </dl>

      {rankedDifferences.length > 0 ? (
        <div className="mt-4 border-t border-line/50 pt-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="text-sm font-medium text-navy">{t("sync.alertDifferences")}</p>
            {surplus.length > 0 ? (
              <p className="text-xs text-muted">
                {t("sync.alertSurplusSummary", { count: surplus.length, units: totalUnits(surplus) })}
              </p>
            ) : null}
            {shortfall.length > 0 ? (
              <p className="text-xs text-muted">
                {t("sync.alertShortfallSummary", { count: shortfall.length, units: totalUnits(shortfall) })}
              </p>
            ) : null}
          </div>

          {/* Held to a reading measure and to a card's worth of height. Four
              columns stretched across a desktop dashboard leave the SKU and
              its own figures a hand-span apart, and fourteen rows pushed every
              KPI on the page below the fold — the banner became the dashboard. */}
          <div className="mt-2 max-h-64 max-w-3xl overflow-auto rounded-lg border border-line/60">
            <table className="w-full text-sm">
              <thead className={`sticky top-0 ${toneFill}`}>
                <tr className="border-b border-line/60 text-xs text-muted">
                  <th scope="col" className="px-3 py-2 text-start font-normal">{t("sync.product")}</th>
                  <th scope="col" className="px-3 py-2 text-end font-normal">{t("sync.warehouse")}</th>
                  <th scope="col" className="px-3 py-2 text-end font-normal">{t("sync.books")}</th>
                  <th scope="col" className="px-3 py-2 text-end font-normal">{t("sync.difference")}</th>
                  <th scope="col" className="px-3 py-2 text-start font-normal">{t("sync.explain.header")}</th>
                </tr>
              </thead>
              <tbody>
                {rankedDifferences.map((d) => (
                  <tr key={d.sku} className="border-t border-line/40">
                    <td className="px-3 py-1.5 font-mono text-xs text-navy">{d.sku}</td>
                    <td className="px-3 py-1.5 text-end tabular-nums text-navy">
                      {formatNumber(d.fastHub, locale)}
                    </td>
                    <td className="px-3 py-1.5 text-end tabular-nums text-navy">
                      {formatNumber(d.books, locale)}
                    </td>
                    {/* The signed delta is the column worth reading: it says at
                        a glance whether goods arrived or went missing. */}
                    <td
                      className={`px-3 py-1.5 text-end font-semibold tabular-nums ${
                        d.delta < 0 ? "text-danger" : "text-navy"
                      }`}
                    >
                      {d.delta > 0 ? "+" : ""}{formatNumber(d.delta, locale)}
                    </td>
                    <td className="px-3 py-1.5 text-xs leading-relaxed text-muted">{explain(d.sku)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

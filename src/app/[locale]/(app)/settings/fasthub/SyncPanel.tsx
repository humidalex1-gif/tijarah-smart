"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PollReport } from "@/services/fasthub/poll";

type Labels = Record<
  | "syncNow" | "syncing" | "syncDone" | "syncOrdersCreated" | "syncClaimsOpened"
  | "syncSettledSellable" | "syncSettledDamaged" | "syncUnknownSkus"
  | "syncQcMissing" | "syncFailures" | "syncDiffs" | "syncNoChanges"
  | "syncOrdersFailed" | "syncPreOpening" | "generic",
  string
>;

/** Quantities are thousandths everywhere in this codebase. */
const units = (scaled: number) => scaled / 1000;

/**
 * Runs the catch-up poll and SHOWS what it did.
 *
 * The reporting is not decoration. A sync that silently found nothing looks
 * exactly like a sync that silently failed, and this project has already
 * shipped one feature that was inert for eight tasks because nothing on
 * screen would have revealed it.
 */
export function SyncPanel({ labels, disabled, errors }: {
  labels: Labels;
  disabled: boolean;
  /**
   * Message keys `action()` can return, already translated by the page. It
   * returns a KEY, never a sentence, and rendering the key put
   * "errors.FASTHUB_TOKEN_EXPIRED" on the one screen the owner opens to find
   * out what is wrong.
   */
  errors: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<PollReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  async function onSync() {
    if (runningRef.current) return;
    runningRef.current = true;
    setPending(true);
    setError(null);
    setReport(null);
    try {
      const { syncFastHubAction } = await import("./actions");
      const result = await syncFastHubAction(new FormData());
      if (result.ok) {
        setReport(result.data ?? null);
        router.refresh();
      } else {
        setError(errors[result.error] ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      runningRef.current = false;
      setPending(false);
    }
  }

  const rows: { label: string; value: string }[] = [];
  if (report) {
    if (report.orders) {
      rows.push({ label: labels.syncOrdersCreated, value: String(report.orders.created) });
    }
    if (report.returns) {
      rows.push({ label: labels.syncClaimsOpened, value: String(report.returns.opened) });
      if (report.returns.settledSellable > 0) {
        rows.push({
          label: labels.syncSettledSellable,
          value: String(units(report.returns.settledSellable)),
        });
      }
      if (report.returns.settledDamaged > 0) {
        rows.push({
          label: labels.syncSettledDamaged,
          value: String(units(report.returns.settledDamaged)),
        });
      }
    }
    if (report.inventory) {
      const differing = report.inventory.lines.filter((l) => l.difference !== 0).length;
      rows.push({ label: labels.syncDiffs, value: String(differing) });
    }
  }

  const unknownSkus = [
    ...(report?.orders?.unknownSkus ?? []),
    ...(report?.returns?.unknownSkus ?? []),
    ...(report?.inventory?.unknownSkus ?? []),
  ];
  const uniqueUnknown = [...new Set(unknownSkus)];
  const quiet = report !== null && rows.every((r) => r.value === "0")
    && uniqueUnknown.length === 0 && (report.returns?.qcSplitMissing.length ?? 0) === 0
    && (report.orders?.failed.length ?? 0) === 0
    && (report.orders?.preOpening.length ?? 0) === 0;

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <button
        type="button"
        onClick={onSync}
        disabled={pending || disabled}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:opacity-50"
      >
        {pending ? labels.syncing : labels.syncNow}
      </button>

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      {report ? (
        <div className="mt-4 space-y-3 text-sm">
          <p className="text-success">{labels.syncDone}</p>

          {quiet ? (
            <p className="text-muted">{labels.syncNoChanges}</p>
          ) : (
            <dl className="space-y-1">
              {rows.map((row) => (
                <div key={row.label} className="flex gap-2">
                  <dt className="text-muted">{row.label}</dt>
                  <dd className="tabular-nums">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* Everything below is a thing the merchant must ACT on. Each one is
              a case where the sync deliberately did nothing rather than guess. */}
          {uniqueUnknown.length > 0 ? (
            <p className="text-warning">
              {labels.syncUnknownSkus}: <span className="font-mono">{uniqueUnknown.join(", ")}</span>
            </p>
          ) : null}

          {report.orders && report.orders.failed.length > 0 ? (
            <p className="text-warning">
              {labels.syncOrdersFailed}: <span className="font-mono">{report.orders.failed.join(", ")}</span>
            </p>
          ) : null}

          {report.orders && report.orders.preOpening.length > 0 ? (
            <p className="text-warning">
              {labels.syncPreOpening}: <span className="font-mono">{report.orders.preOpening.join(", ")}</span>
            </p>
          ) : null}

          {report.returns && report.returns.qcSplitMissing.length > 0 ? (
            <p className="text-warning">
              {labels.syncQcMissing}: <span className="font-mono">{report.returns.qcSplitMissing.join(", ")}</span>
            </p>
          ) : null}

          {report.failures.length > 0 ? (
            <p className="text-danger">
              {labels.syncFailures}: {report.failures.map((f) => f.resource).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

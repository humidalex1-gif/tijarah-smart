"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { recordCountAction, submitForReviewAction } from "../actions";
import { inputClass } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { fillTemplate } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import { fromQty, toQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export interface CountEntryLine {
  id: string;
  /**
   * Scaled (QTY_SCALE); null means nobody has counted this line yet. There
   * is deliberately no `snapshotQty` field here — the page's query never
   * selects it, so there is nothing for this component to leak even if it
   * wanted to.
   */
  countedQty: number | null;
  recountRequested: boolean;
  productName: string;
  /**
   * Null for a simple product (no variants). createStockCount creates one
   * StockCountLine per variant, so without this a shirt in three sizes is
   * three rows sharing the same productName/sku — indistinguishable to the
   * counter, who then fills them in arbitrarily. Never derived from
   * snapshotQty or anything else on the snapshot side; this is the
   * variant's own identity, joined in page.tsx from a separate
   * ProductVariant query.
   */
  variantName: string | null;
  sku: string;
}

export interface CountEntryFormLabels {
  product: string; variant: string; sku: string; countedQty: string; status: string;
  counted: string; notCounted: string; recount: string;
  save: string; loading: string; submitForReview: string;
  /** Unfilled `{counted}`/`{total}` template — see `fillTemplate` below. */
  progressTemplate: string;
  errors: Record<string, string>;
}

export function CountEntryForm({
  locale, sessionId, lines, labels,
}: {
  locale: Locale;
  sessionId: string;
  lines: CountEntryLine[];
  labels: CountEntryFormLabels;
}) {
  const router = useRouter();

  // Keyed by line id: a table of independent single-field forms, one
  // recordCountAction call per row, not one shared submission — a counter
  // moving down the list saves row 3 without disturbing row 7's half-typed
  // entry.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  // What was last successfully sent per line, so valueFor can tell "the
  // server has caught up with my override" from "the server holds a different
  // value than I typed". Without it there is no way to distinguish a landed
  // save from a recount that reset the line.
  const [sentValues, setSentValues] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // A Set of in-flight line ids, not a single id — the previous single-value
  // `savingId`/`savingRef` guarded EVERY row with one flag, so saving row A
  // made row B's (still-enabled) Save button a silent no-op: the click was
  // swallowed by `if (savingRef.current) return` before it ever built a
  // FormData or called the action. Independent rows must be able to save at
  // the same time; only a second click on the SAME row, before its own
  // request resolves, should be swallowed.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  // A ref mirroring the state above, not just the state — two rapid clicks
  // on the same row's save button before React re-renders would otherwise
  // both pass the `savingIds.has(line.id)` disabled check and fire two
  // independent recordCountAction calls for that one row, same rationale as
  // ReceiveTransferForm's submittingRef / AdjustForm's.
  const savingRef = useRef<Set<string>>(new Set());

  const [submitResult, setSubmitResult] = useState<Awaited<ReturnType<typeof submitForReviewAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // The text each row's input actually shows. A per-line override takes over
  // once the counter types, falling back to whatever was last recorded (unit
  // domain, via fromQty) so revisiting a counted line shows their own entry
  // rather than a blank box — never the snapshot, which never reaches this
  // component at all.
  //
  // Surrendering the override is the subtle part. Deleting it the instant
  // recordCountAction resolves is wrong: router.refresh() has not landed yet,
  // so for one render this falls back to the OLD countedQty (null on a first
  // count, the previous number on a recount) and the counter watches their
  // entry vanish and reappear. But never clearing it is also wrong — it would
  // then outlive the truth it represents in two ways:
  //
  //   - toQty rounds to thousandths, so typing 1.2345 stores 1.235 while the
  //     box keeps reading 1.2345. The counter believes a figure was recorded
  //     that was not.
  //   - a reviewer requesting a recount nulls countedQty server-side. That is
  //     precisely the flow where the box must clear, and a sticky override
  //     would leave the counter re-submitting their own stale number.
  //
  // So the override is surrendered exactly when the server has caught up with
  // it: once `countedQty` round-trips back equal to what was sent, the server
  // is authoritative again. Done at render time rather than in an effect,
  // which keeps it out of react-hooks/set-state-in-effect territory.
  function valueFor(line: CountEntryLine): string {
    const override = inputs[line.id];
    if (override === undefined) {
      return line.countedQty !== null ? String(fromQty(line.countedQty)) : "";
    }
    // A recount is the server deliberately discarding this line's count, and
    // it is the one signal that distinguishes "reset by a reviewer" from
    // "router.refresh() has not landed yet" — both leave countedQty null, so
    // without recountRequested the box either flashes blank on every save or
    // keeps showing a number the reviewer just threw away. requestRecount sets
    // this flag in the same write that nulls countedQty; recordCount clears it.
    if (line.recountRequested) return "";
    const sent = sentValues[line.id];
    if (sent !== undefined && line.countedQty !== null) {
      // Compare in the STORED domain, not as strings: toQty rounds to
      // thousandths, so "1.2345" and "1.235" are the same stored quantity —
      // and the stored one is what is true. Once the server agrees with what
      // was sent, it is authoritative again and the override steps aside.
      if (toQty(Number(sent)) === line.countedQty) {
        return String(fromQty(line.countedQty));
      }
    }
    return override;
  }

  async function handleRecord(line: CountEntryLine, value: string) {
    if (savingRef.current.has(line.id) || value.trim() === "") return;
    savingRef.current.add(line.id);
    setSavingIds((prev) => new Set(prev).add(line.id));
    const fd = new FormData();
    fd.set("lineId", line.id);
    // Raw, unit-domain value — recordCountAction's own schema coerces and
    // scales it (toQty) server-side. Scaling it again here would double it.
    fd.set("countedQty", value);
    try {
      const res = await recordCountAction(fd);
      if (res.ok) {
        setRowErrors((prev) => {
          const next = { ...prev };
          delete next[line.id];
          return next;
        });
        // Record what the server now holds for this line, so valueFor can
        // hand authority back once the refresh below lands. Not a clear of
        // the override — clearing here would blank the box for the render
        // before fresh data arrives.
        setSentValues((prev) => ({ ...prev, [line.id]: value }));
        // Re-fetches the session's lines from the server so this row's
        // status flips to "counted". The server component's query still
        // never selects snapshotQty, so a refresh can never leak it either.
        router.refresh();
      } else {
        setRowErrors((prev) => ({ ...prev, [line.id]: labels.errors[res.error] ?? labels.errors["errors.generic"] }));
      }
    } catch (error) {
      // A transport-level failure (the promise itself rejecting) never
      // reaches action()'s own try/catch server-side — surface the same
      // generic message and log the real cause, instead of an unhandled
      // rejection with no feedback for this row.
      console.error("Record count request failed:", error);
      setRowErrors((prev) => ({ ...prev, [line.id]: labels.errors["errors.generic"] }));
    } finally {
      savingRef.current.delete(line.id);
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(line.id);
        return next;
      });
    }
  }

  async function handleSubmitForReview() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("sessionId", sessionId);
    try {
      const res = await submitForReviewAction(fd);
      setSubmitResult(res);
      if (res.ok) router.push(`/${locale}/inventory/counts/${sessionId}/review`);
    } catch (error) {
      console.error("Submit for review request failed:", error);
      setSubmitResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Nothing has been counted yet: submitting would only hit the server's own
  // COUNT_NOTHING_COUNTED rejection, so disable the button rather than let
  // the counter discover that round-trip.
  const hasCounted = lines.some((l) => l.countedQty !== null);

  // "12 of 84 counted" — derived entirely from countedQty's null-ness, the
  // same signal the status badge below already uses. Nothing here refers to
  // (or could be reconstructed into) the snapshot: a total line count and a
  // counted-so-far count leak no expected quantity, unlike a variance or a
  // "matches" comparison would. The real setting for this screen is someone
  // on a phone in a warehouse aisle, who currently has no way to see how
  // much of the list is left.
  const countedCount = lines.filter((l) => l.countedQty !== null).length;
  const progressText = fillTemplate(labels.progressTemplate, {
    counted: formatNumber(countedCount, locale),
    total: formatNumber(lines.length, locale),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{progressText}</p>

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface">
            <tr>
              <th scope="col" className="px-4 py-3 text-start font-medium text-muted">{labels.product}</th>
              <th scope="col" className="px-4 py-3 text-start font-medium text-muted">{labels.variant}</th>
              <th scope="col" className="px-4 py-3 text-start font-medium text-muted">{labels.sku}</th>
              <th scope="col" className="px-4 py-3 text-start font-medium text-muted">{labels.status}</th>
              <th scope="col" className="px-4 py-3 text-end font-medium text-muted">{labels.countedQty}</th>
              <th scope="col" className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const value = valueFor(line);
              const rowError = rowErrors[line.id];
              const isSaving = savingIds.has(line.id);
              // Row-unique accessible name for the otherwise-anonymous
              // number input: the visible column header ("Counted quantity")
              // is shared by every row, which is exactly the ambiguity
              // Finding 1 is about — a screen reader user needs the same
              // product+variant distinction a sighted counter gets from the
              // adjacent cells.
              const qtyLabel = line.variantName
                ? `${labels.countedQty} — ${line.productName} — ${line.variantName}`
                : `${labels.countedQty} — ${line.productName}`;
              return (
                <tr
                  key={line.id}
                  // recountRequested lines get their own background, not just
                  // the status badge below, so they stand out while scanning
                  // a long list rather than only on close reading of the
                  // status column.
                  className={`border-b border-line last:border-0 ${line.recountRequested ? "bg-warning/10" : ""}`}
                >
                  <td className="px-4 py-3">{line.productName}</td>
                  {/* "—" for a simple product with no variant, same
                      empty-cell convention as every other optional column in
                      this codebase (customers/suppliers phone, reference
                      numbers, ...). */}
                  <td className="px-4 py-3 text-muted">{line.variantName ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{line.sku}</td>
                  <td className="px-4 py-3">
                    {/*
                      Deliberately a tick, never a comparison: "matches" or
                      "off by N" would leak the snapshot just as surely as
                      printing it, and this component has no snapshot value
                      to compare against anyway.
                    */}
                    {line.recountRequested ? (
                      <StatusBadge label={labels.recount} tone="warning" />
                    ) : line.countedQty !== null ? (
                      <StatusBadge label={labels.counted} tone="success" />
                    ) : (
                      <StatusBadge label={labels.notCounted} tone="neutral" />
                    )}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <input
                      type="number" min={0} step="0.001"
                      value={value}
                      aria-label={qtyLabel}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [line.id]: e.target.value }))}
                      className={`${inputClass} w-24 text-end`}
                    />
                    {rowError ? <p className="mt-1 text-xs text-danger">{rowError}</p> : null}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <button
                      type="button"
                      disabled={isSaving || value.trim() === ""}
                      aria-busy={isSaving}
                      onClick={() => handleRecord(line, value)}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-brand disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSaving ? labels.loading : labels.save}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {submitResult && !submitResult.ok ? (
        <p className="text-sm text-danger">
          {labels.errors[submitResult.error] ?? labels.errors["errors.generic"]}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmitForReview}
          disabled={submitting || !hasCounted}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {labels.submitForReview}
        </button>
      </div>
    </div>
  );
}

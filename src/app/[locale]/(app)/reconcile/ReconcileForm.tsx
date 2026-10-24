"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toQty, fromQty } from "@/lib/money";
import { formatQty, formatNumber } from "@/lib/format";
import type { Locale } from "@/lib/i18n";
import { inputClass } from "@/components/ui/FormField";

type Row = {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  /** onShelfQty + inDisputeQty. The base the difference column works from. */
  expectedQty: number;
  /** Units the books place on the shelf, sellable today. */
  onShelfQty: number;
  /**
   * Units already in dispute — returns on their way back that the warehouse
   * has not confirmed. Shown separately because comparing the SUM against what
   * Fast Hub reports compares a shelf count against shelf-plus-in-flight, and
   * the gap that falls out of that reads as loss when it is transit.
   */
  inDisputeQty: number;
};

type Labels = Record<
  | "warehouse" | "asOf" | "product" | "sku" | "expected" | "sellable" | "damaged"
  | "gap" | "settleable" | "stillClaimed" | "unexplained" | "surplus"
  | "isPhysicalCount" | "isPhysicalCountHint" | "preview" | "onShelf" | "inDispute"
  | "fastHub" | "theirOnHand" | "syncedHint" | "post" | "posted"
  | "settledCount" | "shrinkagePosted" | "damagedPosted" | "skippedCount" | "generic",
  string
>;

/** The part of the server's ReconcileLine this screen shows. */
type PreviewLine = {
  productId: string;
  variantId: string | null;
  settleableSellable: number;
  settleableDamaged: number;
  stillClaimed: number;
  unexplained: number;
  surplus: number;
};

/**
 * The `الفرق` column is computed in the browser from the expected quantity the
 * server sent. It is deliberately not authoritative: the server recomputes
 * everything in postReconcile against live balances and live claims, because
 * the merchant may sit on this screen for an hour and stock moves underneath
 * them.
 *
 * The browser cannot know about open claims, so that column is a raw
 * difference and nothing more. The split into settleable, still-claimed and
 * unexplained is the actual product of this screen, and it comes from the
 * server — through `previewReconcileAction`, which writes nothing, so it can
 * be read BEFORE the irreversible post rather than only after it.
 *
 * A preview is invalidated the moment any figure changes. Leaving it on screen
 * would show a decomposition of numbers that are no longer the ones typed —
 * the most dangerous state this form could be in, because it looks correct.
 */
export function ReconcileForm({
  locale, warehouses, warehouseId, rows, labels,
}: {
  locale: Locale;
  warehouses: { id: string; name: string }[];
  warehouseId: string;
  rows: Row[];
  labels: Labels;
}) {
  const router = useRouter();
  const [entries, setEntries] = useState<Record<string, { sellable: string; damaged: string }>>({});
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [isPhysicalCount, setIsPhysicalCount] = useState(false);
  const [preview, setPreview] = useState<Record<string, PreviewLine> | null>(null);
  /** Fast Hub's own figures, keyed by productId, once the owner asks for them. */
  const [fastHub, setFastHub] = useState<Record<string, { sellable: number; onHand: number }> | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A state flag alone does not stop a synchronous double-click: React batches
  // the update and the second handler runs against the old value. Same guard
  // as CountEntryForm and the transfer forms.
  const submittingRef = useRef(false);

  const key = (row: Row) => `${row.productId}:${row.variantId ?? ""}`;

  const filled = useMemo(
    () => rows.filter((row) => (entries[key(row)]?.sellable ?? "").trim() !== ""),
    [rows, entries],
  );

  function setField(row: Row, field: "sellable" | "damaged", value: string) {
    const k = key(row);
    // Any edit invalidates the whole preview, not just this row's: the server
    // decomposes against claims shared across the run, so one changed figure
    // can move another row's split.
    setPreview(null);
    setEntries((prev) => {
      const current = prev[k] ?? { sellable: "", damaged: "" };
      return { ...prev, [k]: { ...current, [field]: value } };
    });
  }

  /** The typed figures, in the shape both actions take. */
  function payload() {
    return filled.map((row) => {
      const entry = entries[key(row)];
      const damaged = entry.damaged.trim();
      return {
        productId: row.productId,
        variantId: row.variantId,
        sellable: toQty(Number(entry.sellable)),
        damaged: damaged === "" ? null : toQty(Number(damaged)),
      };
    });
  }

  /**
   * Pulls Fast Hub's figures into the sellable boxes.
   *
   * A BUTTON, never an auto-fill on load. The empty box is a prompt to go and
   * ask a human at the warehouse, and the design doc holds that getting them to
   * state a number is worth more than any code here; filling it silently would
   * remove that prompt and turn the screen into a rubber stamp.
   *
   * The damaged box is deliberately untouched: their inventory endpoint carries
   * available_quantity and quantity_on_hand and no damaged field at all. Blank
   * already means "they did not say", which is the truth.
   */
  async function loadFastHub() {
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("warehouseId", warehouseId);

      const { fastHubFiguresAction } = await import("./actions");
      const result = await fastHubFiguresAction(fd);

      if (!result.ok) {
        setError(result.error ?? labels.generic);
        return;
      }

      const byProduct: Record<string, { sellable: number; onHand: number }> = {};
      for (const line of result.data.lines) {
        byProduct[line.productId] = { sellable: line.sellable, onHand: line.onHand };
      }
      setFastHub(byProduct);

      setEntries((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          const figure = byProduct[row.productId];
          if (!figure) continue;
          const k = key(row);
          next[k] = {
            sellable: String(fromQty(figure.sellable)),
            // Untouched on purpose — see above.
            damaged: prev[k]?.damaged ?? "",
          };
        }
        return next;
      });

      // These are Omniful's bookkeeping, not a person committing to a count.
      // Presenting them as a physical count would show a VERIFIED loss in the
      // profit waterfall, which is exactly what that caveat exists to prevent.
      setIsPhysicalCount(false);
      // The figures changed, so any preview describes numbers that are gone.
      setPreview(null);
    } catch {
      setError(labels.generic);
    } finally {
      setPending(false);
    }
  }

  async function runPreview() {
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("warehouseId", warehouseId);
      fd.append("asOf", asOf);
      fd.append("lines", JSON.stringify(payload()));

      const { previewReconcileAction } = await import("./actions");
      const result = await previewReconcileAction(fd);

      if (result.ok) {
        const byKey: Record<string, PreviewLine> = {};
        for (const line of result.data as PreviewLine[]) {
          byKey[`${line.productId}:${line.variantId ?? ""}`] = line;
        }
        setPreview(byKey);
      } else {
        setError(result.error ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setMessage(null);
    setError(null);

    try {
      const fd = new FormData();
      fd.append("warehouseId", warehouseId);
      fd.append("asOf", asOf);
      if (isPhysicalCount) fd.append("isPhysicalCount", "on");
      fd.append("lines", JSON.stringify(payload()));

      const { postReconcileAction } = await import("./actions");
      const result = await postReconcileAction(fd);

      if (result.ok) {
        setMessage(
          `${labels.posted} ${labels.settledCount}: ${formatQty(result.data.settledClaims, locale)} · ` +
            `${labels.shrinkagePosted}: ${formatQty(result.data.shrinkagePosted, locale)} · ` +
            // Damage was computed and posted but never shown, so a run that
            // wrote off real units reported "Loss posted: 0" and looked inert.
            `${labels.damagedPosted}: ${formatQty(result.data.damagedPosted, locale)} · ` +
            `${labels.skippedCount}: ${formatNumber(result.data.skipped, locale)}`,
        );
        setEntries({});
        setPreview(null);
        router.refresh();
      } else {
        setError(result.error ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      // try/finally, not finally-only: a rejected transport would otherwise
      // leave the form permanently disabled.
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.warehouse}</span>
          <select
            className={`${inputClass} w-auto`}
            value={warehouseId}
            onChange={(e) => router.push(`/${locale}/reconcile?warehouseId=${e.target.value}`)}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.asOf}</span>
          <input
            type="date"
            className={`${inputClass} w-auto`}
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-start text-muted">
              <th scope="col" className="p-2 text-start">{labels.product}</th>
              <th scope="col" className="p-2 text-end">{labels.onShelf}</th>
              <th scope="col" className="p-2 text-end">{labels.inDispute}</th>
              <th scope="col" className="p-2 text-end">{labels.expected}</th>
              {/* Only once asked for. Units reserved for a picked-but-unshipped
                  order depress `sellable` and read exactly like a loss; seeing
                  on-hand beside it is what distinguishes the two. */}
              {fastHub ? (
                <th scope="col" className="p-2 text-end">{labels.theirOnHand}</th>
              ) : null}
              <th scope="col" className="p-2 text-end">{labels.sellable}</th>
              <th scope="col" className="p-2 text-end">{labels.damaged}</th>
              <th scope="col" className="p-2 text-end">{labels.gap}</th>
              {/* Only after a preview: empty columns headed "Unexplained"
                  would read as "nothing unexplained" rather than "not asked". */}
              {preview ? (
                <>
                  <th scope="col" className="p-2 text-end">{labels.settleable}</th>
                  <th scope="col" className="p-2 text-end">{labels.stillClaimed}</th>
                  <th scope="col" className="p-2 text-end">{labels.unexplained}</th>
                  <th scope="col" className="p-2 text-end">{labels.surplus}</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entry = entries[key(row)] ?? { sellable: "", damaged: "" };
              const hasValue = entry.sellable.trim() !== "";
              const asserted = hasValue
                ? toQty(Number(entry.sellable)) +
                  (entry.damaged.trim() === "" ? 0 : toQty(Number(entry.damaged)))
                : null;
              const gap = asserted === null ? null : row.expectedQty - asserted;

              return (
                <tr key={key(row)} className="border-b border-line/60">
                  <td className="p-2">
                    <div>{row.name}</div>
                    <div className="text-xs text-muted">{row.sku}</div>
                  </td>
                  <td className="p-2 text-end tabular-nums">{formatQty(row.onShelfQty, locale)}</td>
                  <td className="p-2 text-end tabular-nums text-muted">
                    {formatQty(row.inDisputeQty, locale)}
                  </td>
                  <td className="p-2 text-end font-medium tabular-nums">
                    {formatQty(row.expectedQty, locale)}
                  </td>
                  {fastHub ? (
                    <td className="p-2 text-end tabular-nums text-muted">
                      {fastHub[row.productId]
                        ? formatQty(fastHub[row.productId].onHand, locale)
                        : "—"}
                    </td>
                  ) : null}
                  <td className="p-2 text-end">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      aria-label={`${labels.sellable} — ${row.name}`}
                      className="w-24 rounded-lg border border-line px-2 py-1 text-end"
                      value={entry.sellable}
                      onChange={(e) => setField(row, "sellable", e.target.value)}
                    />
                  </td>
                  <td className="p-2 text-end">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      aria-label={`${labels.damaged} — ${row.name}`}
                      className="w-24 rounded-lg border border-line px-2 py-1 text-end"
                      value={entry.damaged}
                      onChange={(e) => setField(row, "damaged", e.target.value)}
                    />
                  </td>
                  <td className="p-2 text-end tabular-nums">
                    {gap === null ? "—" : formatQty(gap, locale)}
                  </td>
                  {preview ? (() => {
                    // A row the owner left blank is not in the payload, so the
                    // server returned nothing for it. Dashes, not zeros.
                    const line = preview[key(row)];
                    const cell = (v: number | undefined, danger = false) => (
                      <td className={`p-2 text-end tabular-nums${danger && v ? " text-danger" : ""}`}>
                        {line === undefined ? "—" : formatQty(v ?? 0, locale)}
                      </td>
                    );
                    return (
                      <>
                        {cell(line && line.settleableSellable + line.settleableDamaged)}
                        {cell(line?.stillClaimed)}
                        {cell(line?.unexplained, true)}
                        {cell(line?.surplus)}
                      </>
                    );
                  })() : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Locked off once figures came from the API. A synced number is their
          system's bookkeeping, not a person who walked the shelf, and letting
          it be ticked would present an API reading as a verified loss. */}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={isPhysicalCount}
          disabled={fastHub !== null}
          onChange={(e) => setIsPhysicalCount(e.target.checked)}
        />
        <span>
          <span className="font-medium">{labels.isPhysicalCount}</span>
          <span className="block text-xs text-muted">
            {fastHub ? labels.syncedHint : labels.isPhysicalCountHint}
          </span>
        </span>
      </label>

      {message ? <p className="text-sm text-success">{message}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium disabled:opacity-50"
          disabled={pending}
          onClick={loadFastHub}
        >
          {labels.fastHub}
        </button>

        {/* Deliberately the quieter button, and deliberately before Post:
            reading the decomposition before an irreversible post is the point. */}
        <button
          type="button"
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium disabled:opacity-50"
          disabled={pending || filled.length === 0}
          onClick={runPreview}
        >
          {labels.preview}
        </button>

        <button
          type="button"
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:opacity-50"
          disabled={pending || filled.length === 0}
          onClick={submit}
        >
          {labels.post}
        </button>
      </div>
    </div>
  );
}

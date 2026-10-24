"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createTransferAction, fetchAvailability } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";
import { formatQty } from "@/lib/format";
import { toQty, fromQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

interface Line { key: string; productId: string; quantity: string; available: number | null }

let lineCounter = 0;
function newLine(): Line {
  lineCounter += 1;
  return { key: `line-${lineCounter}`, productId: "", quantity: "", available: null };
}

export interface TransferFormLabels {
  source: string; destination: string; product: string; quantity: string; available: string;
  notes: string; addLine: string; removeLine: string;
  save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string;
  errors: Record<string, string>;
}

export function TransferForm({
  locale, warehouses, products, labels,
}: {
  locale: Locale;
  warehouses: { id: string; name: string }[];
  products: { id: string; nameAr: string; nameEn: string }[];
  labels: TransferFormLabels;
}) {
  const router = useRouter();
  const [sourceWarehouseId, setSourceWarehouseId] = useState("");
  const [destinationWarehouseId, setDestinationWarehouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof createTransferAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — two confirms fired
  // synchronously in the same tick (a genuine rapid double-click, confirmed
  // by direct testing: two server-action calls landed before React ever
  // re-rendered) both read the same stale, pre-update `submitting` closure
  // value, so a state-only check does not block the second one. A ref is
  // mutated immediately, before React re-renders, so it does.
  const submittingRef = useRef(false);

  const productIdsKey = lines.map((l) => l.productId).join("|");
  // Paired positionally with productIdsKey (both derived from `lines` at the
  // same render), so the effect below can zip them back into key->productId
  // pairs without depending on `lines` itself — matching productIdsKey's own
  // existing pattern of using a derived string, not the array, as the dep.
  const lineKeysKey = lines.map((l) => l.key).join("|");

  // Clearing the source leaves nothing to fetch availability against — stale
  // numbers from the PREVIOUS source warehouse must not linger on screen
  // once it's cleared. Adjusted in response to `sourceWarehouseId` changing,
  // during render rather than in the effect below (react-hooks/
  // set-state-in-effect) — same pattern as VariantSection.tsx's identically
  // shaped reset-on-change.
  const [handledSourceWarehouseId, setHandledSourceWarehouseId] = useState(sourceWarehouseId);
  if (sourceWarehouseId !== handledSourceWarehouseId) {
    setHandledSourceWarehouseId(sourceWarehouseId);
    if (!sourceWarehouseId) setLines((prev) => prev.map((l) => ({ ...l, available: null })));
  }

  useEffect(() => {
    let cancelled = false;
    if (!sourceWarehouseId) return;
    const productIds = productIdsKey ? productIdsKey.split("|") : [];
    const lineKeys = lineKeysKey ? lineKeysKey.split("|") : [];
    (async () => {
      const results = await Promise.all(productIds.map(async (pid, i) => ({
        key: lineKeys[i],
        available: pid ? await fetchAvailability(sourceWarehouseId, pid) : null,
      })));
      if (cancelled) return;
      // Keyed by line id, not array position — a line added, removed, or
      // reordered while this fetch was in flight must not land its
      // availability on the wrong row.
      const byKey = new Map(results.map((r) => [r.key, r.available]));
      setLines((prev) => prev.map((line) => (
        byKey.has(line.key) ? { ...line, available: byKey.get(line.key)! } : line
      )));
    })();
    return () => { cancelled = true; };
  }, [sourceWarehouseId, productIdsKey, lineKeysKey]);

  function setLine<K extends keyof Line>(key: string, field: K, value: Line[K]) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }

  const validLines = lines.filter((l) => l.productId && Number(l.quantity) > 0);
  // Submission never goes through the native <form> — ConfirmDialog fires
  // handleSubmit imperatively — so the per-line input's `max` attribute alone
  // is inert as a guard; this comparison (scaled-domain, matching how
  // `available` is already scaled) is what actually stops an obvious
  // over-transfer client-side instead of round-tripping to INSUFFICIENT_STOCK.
  const withinAvailability = validLines.every(
    (l) => l.available === null || toQty(Number(l.quantity)) <= l.available,
  );
  const canSubmit = !!sourceWarehouseId && !!destinationWarehouseId
    && sourceWarehouseId !== destinationWarehouseId && validLines.length > 0
    && withinAvailability;

  const sourceName = warehouses.find((w) => w.id === sourceWarehouseId)?.name ?? "";
  const destinationName = warehouses.find((w) => w.id === destinationWarehouseId)?.name ?? "";

  async function handleSubmit() {
    // Belt and braces alongside ConfirmDialog's own `disabled` prop below —
    // the dialog can also be confirmed by keyboard, and this is a
    // non-idempotent stock mutation, so a second in-flight call must never
    // reach the server a second time.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("sourceWarehouseId", sourceWarehouseId);
    fd.set("destinationWarehouseId", destinationWarehouseId);
    fd.set("notes", notes);
    fd.set("linesJson", JSON.stringify(
      validLines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })),
    ));
    // finally, not a plain post-await reset: a transport-level rejection
    // (network drop, RSC deserialization failure) would otherwise leave
    // submittingRef/submitting stuck true forever — the trigger permanently
    // disabled and the form dead until reload, which is worse than the
    // pre-fix behavior (only the label got stuck; the form stayed usable).
    try {
      const res = await createTransferAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/inventory/transfers`);
    } catch (error) {
      // A transport-level failure (the promise itself rejecting) never
      // reaches action()'s own try/catch server-side — it never got that
      // far. Surface the same generic banner action() shows for an
      // unexpected server error, and log the real cause, instead of leaving
      // this as an unhandled rejection with no feedback.
      console.error("Create transfer request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const confirmMessage = fillTemplate(labels.confirmMessageTemplate, {
    source: sourceName, destination: destinationName,
  });

  // linesJson is a hidden, client-built field (see handleSubmit above) — a
  // failure decoding it server-side (a corrupt payload, or more than 200
  // lines) is about the LINE ITEMS specifically, not the form in general, so
  // it gets its own spot next to them instead of only the generic banner
  // every other error falls back to below.
  const linesError = result && !result.ok ? result.fields?.linesJson : undefined;
  const linesErrorMessage = linesError ? (labels.errors[linesError] ?? linesError) : undefined;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label={labels.source} required>
          <select value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </FormField>
        <FormField label={labels.destination} required>
          <select value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </FormField>
      </div>
      {sourceWarehouseId && destinationWarehouseId && sourceWarehouseId === destinationWarehouseId ? (
        <p className="text-sm text-danger">{labels.errors["errors.SAME_WAREHOUSE"]}</p>
      ) : null}

      <div className="space-y-3">
        {lines.map((line, i) => (
          <div key={line.key} className="flex items-end gap-2 rounded-lg border border-line bg-panel p-3">
            <div className="flex-1">
              <FormField label={i === 0 ? labels.product : ""}>
                <select
                  value={line.productId} onChange={(e) => setLine(line.key, "productId", e.target.value)}
                  className={inputClass}
                >
                  <option value="">—</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{locale === "ar" ? p.nameAr : p.nameEn}</option>
                  ))}
                </select>
                {line.available !== null ? (
                  <span className="mt-1 block text-xs text-muted">
                    {labels.available}: {formatQty(line.available, locale)}
                  </span>
                ) : null}
              </FormField>
            </div>
            <div className="w-32">
              <FormField label={i === 0 ? labels.quantity : ""}>
                <input
                  type="number" min={0} step="0.001"
                  max={line.available !== null ? fromQty(line.available) : undefined}
                  value={line.quantity} onChange={(e) => setLine(line.key, "quantity", e.target.value)}
                  className={inputClass}
                />
              </FormField>
            </div>
            <button
              type="button"
              onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== line.key) : prev))}
              disabled={lines.length <= 1}
              className="mb-1 shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-danger disabled:opacity-40"
            >
              {labels.removeLine}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, newLine()])}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-brand"
        >
          {labels.addLine}
        </button>
      </div>
      {linesErrorMessage ? <p className="text-sm text-danger">{linesErrorMessage}</p> : null}

      <FormField label={labels.notes}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </FormField>

      {result && !result.ok && !linesErrorMessage ? (
        <p className="text-sm text-danger">
          {labels.errors[result.error] ?? labels.errors["errors.generic"]}
        </p>
      ) : null}

      <div className="flex gap-2">
        {canSubmit ? (
          <ConfirmDialog
            triggerLabel={submitting ? labels.loading : labels.save}
            title={labels.confirmTitle}
            message={confirmMessage}
            confirmLabel={labels.confirm}
            cancelLabel={labels.cancel}
            tone="brand"
            onConfirmAction={handleSubmit}
            disabled={submitting}
          />
        ) : (
          <button type="button" disabled className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink opacity-60">
            {labels.save}
          </button>
        )}
        <button type="button" onClick={() => router.back()} className="rounded-lg border border-line px-4 py-2 text-sm">
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { adjustStockAction, fetchAvailability } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";
import { formatQty, formatNumber } from "@/lib/format";
import { toQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export interface AdjustFormLabels {
  warehouse: string; product: string; systemQty: string; countedQty: string; difference: string;
  reason: string; notes: string; save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string;
  errors: Record<string, string>;
}

export function AdjustForm({
  locale, warehouses, products, labels,
}: {
  locale: Locale;
  warehouses: { id: string; name: string }[];
  products: { id: string; nameAr: string; nameEn: string }[];
  labels: AdjustFormLabels;
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState("");
  const [productId, setProductId] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [systemQty, setSystemQty] = useState<number | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof adjustStockAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — two confirms fired
  // synchronously in the same tick (a genuine rapid double-click, confirmed
  // by direct testing: two server-action calls landed before React ever
  // re-rendered) both read the same stale, pre-update `submitting` closure
  // value, so a state-only check does not block the second one. A ref is
  // mutated immediately, before React re-renders, so it does.
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const qty = (!warehouseId || !productId) ? null : await fetchAvailability(warehouseId, productId);
      if (!cancelled) setSystemQty(qty);
    })();
    return () => { cancelled = true; };
  }, [warehouseId, productId]);

  const newQtyNum = Number(newQuantity);
  const canSubmit = !!warehouseId && !!productId
    && newQuantity.trim() !== "" && Number.isFinite(newQtyNum) && newQtyNum >= 0
    && reason.trim() !== "";

  const selectedProduct = products.find((p) => p.id === productId);
  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId);
  const productName = selectedProduct ? (locale === "ar" ? selectedProduct.nameAr : selectedProduct.nameEn) : "";

  // Computed in the scaled integer domain (toQty), not by subtracting the
  // display-domain floats — 20.5 - 20.2 in floating point renders as
  // -0.2999999999999972 instead of -0.3. Rendered below through formatQty,
  // not interpolated raw, so `ar` shows Arabic-Indic digits like every other
  // quantity on screen instead of Western ones.
  const differenceScaled = Number.isFinite(newQtyNum) ? toQty(newQuantity) - (systemQty ?? 0) : 0;

  async function handleSubmit() {
    // Belt and braces alongside ConfirmDialog's own `disabled` prop below —
    // the dialog can also be confirmed by keyboard, and this is a
    // non-idempotent stock mutation, so a second in-flight call must never
    // reach the server a second time.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("warehouseId", warehouseId);
    fd.set("productId", productId);
    fd.set("newQuantity", newQuantity);
    fd.set("reason", reason);
    fd.set("notes", notes);
    // finally, not a plain post-await reset: a transport-level rejection
    // (network drop, RSC deserialization failure) would otherwise leave
    // submittingRef/submitting stuck true forever — the trigger permanently
    // disabled and the form dead until reload, which is worse than the
    // pre-fix behavior (only the label got stuck; the form stayed usable).
    try {
      const res = await adjustStockAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/inventory`);
    } catch (error) {
      // A transport-level failure (the promise itself rejecting) never
      // reaches action()'s own try/catch server-side — it never got that
      // far. Surface the same generic banner action() shows for an
      // unexpected server error, and log the real cause, instead of leaving
      // this as an unhandled rejection with no feedback.
      console.error("Adjust stock request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const fieldErrors = result && !result.ok ? result.fields : undefined;
  function fieldError(name: string): string | undefined {
    const raw = fieldErrors?.[name];
    if (raw === undefined) return undefined;
    return labels.errors[raw] ?? raw;
  }

  const confirmMessage = fillTemplate(labels.confirmMessageTemplate, {
    product: productName, warehouse: selectedWarehouse?.name ?? "",
    before: formatQty(systemQty ?? 0, locale),
    after: Number.isFinite(newQtyNum) ? formatNumber(newQtyNum, locale) : newQuantity,
  });

  return (
    <div className="max-w-lg space-y-4">
      <FormField label={labels.warehouse} required>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={inputClass}>
          <option value="">—</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </FormField>

      <FormField label={labels.product} required>
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className={inputClass}>
          <option value="">—</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{locale === "ar" ? p.nameAr : p.nameEn}</option>
          ))}
        </select>
      </FormField>

      {systemQty !== null ? (
        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <span className="text-muted">{labels.systemQty}: </span>
          <span className="font-medium">{formatQty(systemQty, locale)}</span>
        </div>
      ) : null}

      <FormField label={labels.countedQty} required error={fieldError("newQuantity")}>
        <input
          type="number" min={0} step="0.001" required
          value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)}
          className={inputClass}
        />
      </FormField>

      {newQuantity.trim() !== "" ? (
        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <span className="text-muted">{labels.difference}: </span>
          <span className={differenceScaled < 0 ? "font-medium text-danger" : differenceScaled > 0 ? "font-medium text-success" : "font-medium"}>
            {differenceScaled > 0 ? "+" : ""}{formatQty(differenceScaled, locale)}
          </span>
        </div>
      ) : null}

      <FormField label={labels.reason} required error={fieldError("reason")}>
        <input
          type="text" required
          value={reason} onChange={(e) => setReason(e.target.value)}
          className={inputClass}
        />
      </FormField>

      <FormField label={labels.notes}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </FormField>

      {result && !result.ok ? (
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

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { issueStockAction, fetchAvailability } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";
import { formatQty, formatNumber } from "@/lib/format";
import { toQty, fromQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

const REASONS = ["INTERNAL_USE", "PROMOTIONAL_USE", "DAMAGED", "LOST"] as const;

export interface IssueFormLabels {
  warehouse: string; product: string; quantity: string; reason: string; notes: string;
  available: string; save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string; insufficientTemplate: string;
  reasonLabels: Record<(typeof REASONS)[number], string>;
  errors: Record<string, string>;
}

export function IssueForm({
  locale, warehouses, products, labels,
}: {
  locale: Locale;
  warehouses: { id: string; name: string }[];
  products: { id: string; nameAr: string; nameEn: string }[];
  labels: IssueFormLabels;
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<(typeof REASONS)[number]>("INTERNAL_USE");
  const [notes, setNotes] = useState("");
  const [available, setAvailable] = useState<number | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof issueStockAction>> | null>(null);
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
      if (!cancelled) setAvailable(qty);
    })();
    return () => { cancelled = true; };
  }, [warehouseId, productId]);

  const quantityNum = Number(quantity);
  // Submission never goes through the native <form> — ConfirmDialog fires
  // handleSubmit imperatively — so the input's `max` attribute alone is
  // inert as a guard; this comparison is what actually stops an obvious
  // over-issue client-side instead of round-tripping to INSUFFICIENT_STOCK.
  // Both sides compared in the scaled integer domain (toQty), matching how
  // `available` itself is already scaled.
  const canSubmit = !!warehouseId && !!productId
    && quantity.trim() !== "" && Number.isFinite(quantityNum) && quantityNum > 0
    && (available === null || toQty(quantityNum) <= available);

  const selectedProduct = products.find((p) => p.id === productId);
  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId);
  const productName = selectedProduct ? (locale === "ar" ? selectedProduct.nameAr : selectedProduct.nameEn) : "";

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
    fd.set("quantity", quantity);
    fd.set("reason", reason);
    fd.set("notes", notes);
    // finally, not a plain post-await reset: a transport-level rejection
    // (network drop, RSC deserialization failure) would otherwise leave
    // submittingRef/submitting stuck true forever — the trigger permanently
    // disabled and the form dead until reload, which is worse than the
    // pre-fix behavior (only the label got stuck; the form stayed usable).
    try {
      const res = await issueStockAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/inventory`);
    } catch (error) {
      // A transport-level failure (the promise itself rejecting) never
      // reaches action()'s own try/catch server-side — it never got that
      // far. Surface the same generic banner action() shows for an
      // unexpected server error, and log the real cause, instead of leaving
      // this as an unhandled rejection with no feedback.
      console.error("Issue stock request failed:", error);
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
    qty: Number.isFinite(quantityNum) ? formatNumber(quantityNum, locale) : quantity,
    product: productName, warehouse: selectedWarehouse?.name ?? "",
  });

  // INSUFFICIENT_STOCK carries no `product`/`available` back from the server
  // (action() only ever echoes the ServiceError's CODE — see the doc comment
  // on `fetchAvailability` in ../actions.ts) — this is built from the SAME
  // values already shown beside the quantity input above.
  const insufficientMessage = result && !result.ok && result.code === "INSUFFICIENT_STOCK"
    ? fillTemplate(labels.insufficientTemplate, {
      product: productName, available: formatQty(available ?? 0, locale),
    })
    : null;

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
        {available !== null ? (
          <span className="mt-1 block text-xs text-muted">
            {labels.available}: {formatQty(available, locale)}
          </span>
        ) : null}
      </FormField>

      <FormField label={labels.quantity} required error={fieldError("quantity")}>
        <input
          type="number" min={0} step="0.001"
          max={available !== null ? fromQty(available) : undefined} required
          value={quantity} onChange={(e) => setQuantity(e.target.value)}
          className={inputClass}
        />
      </FormField>

      <FormField label={labels.reason} required>
        <select value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])} className={inputClass}>
          {REASONS.map((r) => <option key={r} value={r}>{labels.reasonLabels[r]}</option>)}
        </select>
      </FormField>

      <FormField label={labels.notes}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </FormField>

      {insufficientMessage ? (
        <p className="text-sm text-danger">{insufficientMessage}</p>
      ) : result && !result.ok ? (
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

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { receivePurchaseAction } from "../../actions";
import { inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";
import { formatQty } from "@/lib/format";
import { toQty, fromQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

interface ItemLine {
  itemId: string;
  productName: string;
  orderedQty: number;
  receivedQty: number;
  /** Scaled (QTY_SCALE) remaining quantity: orderedQty - receivedQty. */
  remainingQty: number;
  acceptedQty: string;
  damagedQty: string;
}

export interface ReceivePurchaseFormLabels {
  product: string; orderedQty: string; alreadyReceived: string; remaining: string;
  acceptedQty: string; damagedQty: string;
  save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string; landedCostHint: string;
  errors: Record<string, string>;
}

export function ReceivePurchaseForm({
  locale, purchaseOrderId, purchaseOrderNumber, warehouseName, items, labels,
}: {
  locale: Locale;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  warehouseName: string;
  items: { itemId: string; productName: string; orderedQty: number; receivedQty: number }[];
  labels: ReceivePurchaseFormLabels;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<ItemLine[]>(
    items.map((item) => ({
      itemId: item.itemId,
      productName: item.productName,
      orderedQty: item.orderedQty,
      receivedQty: item.receivedQty,
      remainingQty: item.orderedQty - item.receivedQty,
      // Left blank, not pre-filled with the full remaining quantity — unlike
      // a transfer receipt (where the shipped quantity IS what's expected to
      // arrive), a purchase receipt is routinely partial (a container splits
      // across several shipments), so defaulting every line to "receive it
      // all" would silently over-state a merchant's actual delivery unless
      // they remember to edit every single row.
      acceptedQty: "", damagedQty: "0",
    })),
  );
  const [result, setResult] = useState<Awaited<ReturnType<typeof receivePurchaseAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — two confirms fired
  // synchronously in the same tick both read the same stale, pre-update
  // `submitting` closure value, so a state-only check does not block the
  // second one. Same pattern as every other Task 6/7 mutation form.
  const submittingRef = useRef(false);

  function setLine(itemId: string, field: "acceptedQty" | "damagedQty", value: string) {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, [field]: value } : l)));
  }

  // Comparisons run in the SCALED integer domain (toQty), never on the raw
  // decimal strings/floats — matching ReceiveTransferForm.tsx's identical
  // rationale (0.1 + 0.2 !== 0.3 in floating point).
  function totalScaled(line: ItemLine): number {
    const accepted = line.acceptedQty.trim() === "" ? 0 : toQty(line.acceptedQty);
    const damaged = line.damagedQty.trim() === "" ? 0 : toQty(line.damagedQty);
    return accepted + damaged;
  }
  function overLimit(line: ItemLine): boolean {
    return totalScaled(line) > line.remainingQty;
  }

  const activeLines = lines.filter((l) => totalScaled(l) > 0);
  const canSubmit = activeLines.length > 0 && lines.every((l) => !overLimit(l));

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("purchaseOrderId", purchaseOrderId);
    fd.set("linesJson", JSON.stringify(lines.map((l) => ({
      purchaseOrderItemId: l.itemId,
      acceptedQty: l.acceptedQty.trim() === "" ? 0 : Number(l.acceptedQty),
      damagedQty: l.damagedQty.trim() === "" ? 0 : Number(l.damagedQty),
    }))));
    try {
      const res = await receivePurchaseAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/purchases/${purchaseOrderId}`);
    } catch (error) {
      console.error("Receive purchase request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const confirmMessage = fillTemplate(labels.confirmMessageTemplate, {
    number: purchaseOrderNumber, warehouse: warehouseName,
  });

  const linesError = result && !result.ok ? result.fields?.linesJson : undefined;
  const linesErrorMessage = linesError ? (labels.errors[linesError] ?? linesError) : undefined;

  return (
    <div className="max-w-3xl space-y-4">
      <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">{labels.landedCostHint}</p>

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface">
            <tr>
              <th className="px-4 py-3 text-start font-medium text-muted">{labels.product}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.orderedQty}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.alreadyReceived}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.remaining}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.acceptedQty}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.damagedQty}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const over = overLimit(line);
              return (
                <tr key={line.itemId} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">{line.productName}</td>
                  <td className="px-4 py-3 text-end">{formatQty(line.orderedQty, locale)}</td>
                  <td className="px-4 py-3 text-end">{formatQty(line.receivedQty, locale)}</td>
                  <td className="px-4 py-3 text-end">{formatQty(line.remainingQty, locale)}</td>
                  <td className="px-4 py-3 text-end">
                    <input
                      type="number" min={0} step="0.001" max={fromQty(line.remainingQty)}
                      value={line.acceptedQty}
                      onChange={(e) => setLine(line.itemId, "acceptedQty", e.target.value)}
                      className={`${inputClass} w-24 text-end ${over ? "border-danger" : ""}`}
                    />
                  </td>
                  <td className="px-4 py-3 text-end">
                    <input
                      type="number" min={0} step="0.001" max={fromQty(line.remainingQty)}
                      value={line.damagedQty}
                      onChange={(e) => setLine(line.itemId, "damagedQty", e.target.value)}
                      className={`${inputClass} w-24 text-end ${over ? "border-danger" : ""}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {linesErrorMessage ? <p className="text-sm text-danger">{linesErrorMessage}</p> : null}

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

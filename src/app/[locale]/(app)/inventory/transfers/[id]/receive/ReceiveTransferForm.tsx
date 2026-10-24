"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { receiveTransferAction } from "../../../actions";
import { inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";
import { formatQty } from "@/lib/format";
import { toQty, fromQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

interface ItemLine {
  itemId: string;
  productName: string;
  /** Scaled (QTY_SCALE) quantity, exactly as shipped. */
  shippedQty: number;
  receivedQty: string;
  damagedQty: string;
}

export interface ReceiveTransferFormLabels {
  product: string; shippedQty: string; receivedQty: string; damagedQty: string; remaining: string;
  save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string; receiveAllHint: string;
  errors: Record<string, string>;
}

export function ReceiveTransferForm({
  locale, transferId, transferNumber, destinationName, items, labels,
}: {
  locale: Locale;
  transferId: string;
  transferNumber: string;
  destinationName: string;
  items: { itemId: string; productName: string; shippedQty: number }[];
  labels: ReceiveTransferFormLabels;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<ItemLine[]>(
    items.map((item) => ({
      itemId: item.itemId,
      productName: item.productName,
      shippedQty: item.shippedQty,
      // Full receipt is the common case — pre-filled so the merchant only
      // has to adjust the exceptional lines (a short shipment, damage).
      receivedQty: String(fromQty(item.shippedQty)),
      damagedQty: "0",
    })),
  );
  const [result, setResult] = useState<Awaited<ReturnType<typeof receiveTransferAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — two confirms fired
  // synchronously in the same tick (a genuine rapid double-click, confirmed
  // by direct testing: two server-action calls landed before React ever
  // re-rendered) both read the same stale, pre-update `submitting` closure
  // value, so a state-only check does not block the second one. A ref is
  // mutated immediately, before React re-renders, so it does.
  const submittingRef = useRef(false);

  function setLine(itemId: string, field: "receivedQty" | "damagedQty", value: string) {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, [field]: value } : l)));
  }

  // Comparisons run in the SCALED integer domain (toQty), never on the raw
  // decimal strings/floats — 0.1 + 0.2 !== 0.3 in floating point, and
  // `receiveTransfer` itself rejects anything that doesn't sum to EXACTLY
  // the shipped quantity (TRANSFER_NOT_FULLY_RECEIVED / RECEIVED_EXCEEDS_SHIPPED).
  function remaining(line: ItemLine): number {
    const received = line.receivedQty.trim() === "" ? 0 : toQty(line.receivedQty);
    const damaged = line.damagedQty.trim() === "" ? 0 : toQty(line.damagedQty);
    return line.shippedQty - received - damaged;
  }

  const canSubmit = lines.length > 0 && lines.every((l) => remaining(l) === 0);

  async function handleSubmit() {
    // Belt and braces alongside ConfirmDialog's own `disabled` prop below —
    // the dialog can also be confirmed by keyboard, and this is a
    // non-idempotent stock mutation, so a second in-flight call must never
    // reach the server a second time.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("transferId", transferId);
    fd.set("linesJson", JSON.stringify(lines.map((l) => ({
      itemId: l.itemId,
      receivedQty: l.receivedQty.trim() === "" ? 0 : Number(l.receivedQty),
      damagedQty: l.damagedQty.trim() === "" ? 0 : Number(l.damagedQty),
    }))));
    // finally, not a plain post-await reset: a transport-level rejection
    // (network drop, RSC deserialization failure) would otherwise leave
    // submittingRef/submitting stuck true forever — the trigger permanently
    // disabled and the form dead until reload, which is worse than the
    // pre-fix behavior (only the label got stuck; the form stayed usable).
    try {
      const res = await receiveTransferAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/inventory/transfers`);
    } catch (error) {
      // A transport-level failure (the promise itself rejecting) never
      // reaches action()'s own try/catch server-side — it never got that
      // far. Surface the same generic banner action() shows for an
      // unexpected server error, and log the real cause, instead of leaving
      // this as an unhandled rejection with no feedback.
      console.error("Receive transfer request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const confirmMessage = fillTemplate(labels.confirmMessageTemplate, {
    transferNumber, destination: destinationName,
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
      <p className="text-sm text-muted">{labels.receiveAllHint}</p>

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface">
            <tr>
              <th className="px-4 py-3 text-start font-medium text-muted">{labels.product}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.shippedQty}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.receivedQty}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.damagedQty}</th>
              <th className="px-4 py-3 text-end font-medium text-muted">{labels.remaining}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const rem = remaining(line);
              return (
                <tr key={line.itemId} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">{line.productName}</td>
                  <td className="px-4 py-3 text-end">{formatQty(line.shippedQty, locale)}</td>
                  <td className="px-4 py-3 text-end">
                    <input
                      type="number" min={0} step="0.001"
                      value={line.receivedQty}
                      onChange={(e) => setLine(line.itemId, "receivedQty", e.target.value)}
                      className={`${inputClass} w-24 text-end`}
                    />
                  </td>
                  <td className="px-4 py-3 text-end">
                    <input
                      type="number" min={0} step="0.001"
                      value={line.damagedQty}
                      onChange={(e) => setLine(line.itemId, "damagedQty", e.target.value)}
                      className={`${inputClass} w-24 text-end`}
                    />
                  </td>
                  <td className={`px-4 py-3 text-end font-medium ${rem === 0 ? "text-success" : "text-danger"}`}>
                    {formatQty(rem, locale)}
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

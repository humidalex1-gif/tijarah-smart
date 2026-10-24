"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { processReturnAction } from "../../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Money } from "@/components/ui/Money";
import { fillTemplate } from "@/lib/i18n";
import { formatQty, formatMoney } from "@/lib/format";
import { toQty, fromQty, toMinor } from "@/lib/money";
import type { ReturnCondition } from "@/lib/constants";
import type { Locale } from "@/lib/i18n";

interface ItemLine {
  itemId: string;
  productName: string;
  soldQty: number;
  returnedQty: number;
  /** Scaled (QTY_SCALE) remaining quantity: soldQty - returnedQty. */
  remainingQty: number;
  quantity: string;
  condition: ReturnCondition;
  warehouseId: string;
  refundAmount: string;
}

export interface ReturnFormLabels {
  product: string; soldQty: string; alreadyReturned: string; remaining: string;
  returnQty: string; condition: string; conditionOptions: Record<ReturnCondition, string>;
  targetWarehouse: string; refundAmount: string; refundAccount: string; returnReason: string;
  maxRefundHintTemplate: string;
  save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string;
  errors: Record<string, string>;
}

export function ReturnForm({
  locale, currency, salesOrderId, hasCustomer, defaultWarehouseId, defaultWarehouseName,
  warehouses, accounts, maxRefund, items, labels,
}: {
  locale: Locale;
  currency: string;
  salesOrderId: string;
  hasCustomer: boolean;
  defaultWarehouseId: string;
  defaultWarehouseName: string;
  warehouses: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  /** grandTotal - refundedAmount, in minor units — the true cap processReturn enforces (REFUND_EXCEEDS_ORDER). */
  maxRefund: number;
  items: { itemId: string; productName: string; soldQty: number; returnedQty: number }[];
  labels: ReturnFormLabels;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<ItemLine[]>(
    items.map((item) => ({
      itemId: item.itemId,
      productName: item.productName,
      soldQty: item.soldQty,
      returnedQty: item.returnedQty,
      remainingQty: item.soldQty - item.returnedQty,
      // Left blank, not pre-filled — same rationale as ReceivePurchaseForm's
      // acceptedQty: a return is routinely partial, so defaulting every line
      // to "return it all" would silently over-state the merchant's intent.
      quantity: "", condition: "SELLABLE", warehouseId: defaultWarehouseId, refundAmount: "",
    })),
  );
  const [reason, setReason] = useState("");
  // Blank by default, even on a customer order — NOT accounts[0]?.id.
  // processReturn's cash-refund branch is gated on `refundAccountId` being
  // present, not on the refund amount, so a pre-filled account on a
  // zero-refund exchange/restock return would silently take the CASH-OUT
  // path (a Payment{REFUND, amount: 0} row in two tables plus two zero
  // ledger rows) instead of leaving the refund as a credit note against the
  // customer's balance. Only a genuinely non-zero refund should ever send
  // an accountId at all — see handleSubmit below.
  const [refundAccountId, setRefundAccountId] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof processReturnAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — same double-submit guard
  // as every other Task 6/7/8 mutation form.
  const submittingRef = useRef(false);

  function setLine<K extends keyof ItemLine>(itemId: string, field: K, value: ItemLine[K]) {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, [field]: value } : l)));
  }

  // Comparisons run in the SCALED integer domain (toQty), never on the raw
  // decimal strings/floats — same rationale as ReceivePurchaseForm.tsx.
  const computed = useMemo(() => lines.map((line) => {
    const qty = line.quantity.trim() === "" ? 0 : toQty(line.quantity);
    const over = qty > line.remainingQty;
    const refund = line.refundAmount.trim() === "" ? 0 : toMinor(line.refundAmount);
    return { ...line, qty, over, refund };
  }), [lines]);

  const activeLines = computed.filter((l) => l.qty > 0);
  const refundTotal = activeLines.reduce((s, l) => s + l.refund, 0);
  const refundExceedsOrder = refundTotal > maxRefund;
  // Walk-in orders (no customerId) have nowhere for a non-zero refund to
  // land except a cash/bank account — processReturn throws
  // REFUND_DESTINATION_REQUIRED otherwise (Task 8 brief).
  const refundAccountRequired = !hasCustomer && refundTotal > 0;
  const canSubmit = activeLines.length > 0
    && computed.every((l) => !l.over)
    && !refundExceedsOrder
    && (!refundAccountRequired || !!refundAccountId);

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("salesOrderId", salesOrderId);
    if (reason) fd.set("reason", reason);
    // Only when the refund is actually non-zero — same `> 0` gating
    // SaleForm.tsx uses for `paidAmountMinor` before it sends an accountId.
    // processReturn branches on the PRESENCE of refundAccountId, not the
    // refund amount, so sending it unconditionally (even blank-string-
    // guarded) on a zero-refund return would still trigger a cash-out leg.
    if (refundTotal > 0 && refundAccountId) fd.set("refundAccountId", refundAccountId);
    fd.set("linesJson", JSON.stringify(lines.map((l) => ({
      salesOrderItemId: l.itemId,
      quantity: l.quantity.trim() === "" ? 0 : Number(l.quantity),
      condition: l.condition,
      warehouseId: l.warehouseId,
      refundAmount: l.refundAmount.trim() === "" ? 0 : Number(l.refundAmount),
    }))));
    try {
      const res = await processReturnAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/sales/${salesOrderId}`);
    } catch (error) {
      console.error("Process return request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const confirmMessage = fillTemplate(labels.confirmMessageTemplate, {
    amount: formatMoney(refundTotal, locale, currency),
    warehouse: defaultWarehouseName,
  });
  const maxRefundHint = fillTemplate(labels.maxRefundHintTemplate, {
    amount: formatMoney(maxRefund, locale, currency),
  });

  const linesError = result && !result.ok ? result.fields?.linesJson : undefined;
  const linesErrorMessage = linesError ? (labels.errors[linesError] ?? linesError) : undefined;

  return (
    <div className="max-w-4xl space-y-4">
      <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">{maxRefundHint}</p>

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface">
            <tr>
              <th className="px-3 py-2 text-start font-medium text-muted">{labels.product}</th>
              <th className="px-3 py-2 text-end font-medium text-muted">{labels.soldQty}</th>
              <th className="px-3 py-2 text-end font-medium text-muted">{labels.alreadyReturned}</th>
              <th className="px-3 py-2 text-end font-medium text-muted">{labels.remaining}</th>
              <th className="px-3 py-2 text-end font-medium text-muted">{labels.returnQty}</th>
              <th className="px-3 py-2 text-start font-medium text-muted">{labels.condition}</th>
              <th className="px-3 py-2 text-start font-medium text-muted">{labels.targetWarehouse}</th>
              <th className="px-3 py-2 text-end font-medium text-muted">{labels.refundAmount}</th>
            </tr>
          </thead>
          <tbody>
            {computed.map((line) => (
              <tr key={line.itemId} className="border-b border-line last:border-0">
                <td className="px-3 py-2">{line.productName}</td>
                <td className="px-3 py-2 text-end">{formatQty(line.soldQty, locale)}</td>
                <td className="px-3 py-2 text-end">{formatQty(line.returnedQty, locale)}</td>
                <td className="px-3 py-2 text-end">{formatQty(line.remainingQty, locale)}</td>
                <td className="px-3 py-2">
                  <input
                    type="number" min={0} step="0.001" max={fromQty(line.remainingQty)}
                    value={line.quantity}
                    onChange={(e) => setLine(line.itemId, "quantity", e.target.value)}
                    className={`${inputClass} w-24 text-end ${line.over ? "border-danger" : ""}`}
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={line.condition}
                    onChange={(e) => setLine(line.itemId, "condition", e.target.value as ReturnCondition)}
                    className={`${inputClass} w-32`}
                  >
                    {(Object.keys(labels.conditionOptions) as ReturnCondition[]).map((c) => (
                      <option key={c} value={c}>{labels.conditionOptions[c]}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={line.warehouseId}
                    onChange={(e) => setLine(line.itemId, "warehouseId", e.target.value)}
                    className={`${inputClass} w-36`}
                  >
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number" min={0} step="0.01"
                    value={line.refundAmount}
                    onChange={(e) => setLine(line.itemId, "refundAmount", e.target.value)}
                    className={`${inputClass} w-28 text-end`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {linesErrorMessage ? <p className="text-sm text-danger">{linesErrorMessage}</p> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label={labels.returnReason}>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.refundAccount} required={refundAccountRequired}>
          <select value={refundAccountId} onChange={(e) => setRefundAccountId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </FormField>
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <span className="font-semibold">{labels.refundAmount}</span>
          <span className="text-lg font-semibold">
            <Money minor={refundTotal} locale={locale} currency={currency} />
          </span>
        </div>
        {refundExceedsOrder ? (
          <p className="mt-2 text-sm text-danger">{labels.errors["errors.REFUND_EXCEEDS_ORDER"]}</p>
        ) : null}
        {refundAccountRequired && !refundAccountId ? (
          <p className="mt-2 text-sm text-danger">{labels.errors["errors.REFUND_DESTINATION_REQUIRED"]}</p>
        ) : null}
      </div>

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

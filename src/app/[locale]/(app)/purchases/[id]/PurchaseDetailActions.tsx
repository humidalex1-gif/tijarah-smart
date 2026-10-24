"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { confirmPurchaseOrderAction, cancelPurchaseOrderAction } from "../actions";
// The single hardened recordSupplierPaymentAction lives in finance/actions.ts
// (gated on ["payments.create", "purchases.view"]) — purchases/actions.ts no
// longer has its own copy, so there is one action with one gate and no drift.
import { recordSupplierPaymentAction } from "../../finance/actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField, inputClass } from "@/components/ui/FormField";
import { fillTemplate } from "@/lib/i18n";
import { formatMoney } from "@/lib/format";
import { fromMinor, toMinor } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export interface PurchaseDetailActionsLabels {
  confirmOrder: string; confirmOrderTitle: string; confirmOrderMessage: string;
  cancelOrder: string; cancelReason: string; cancelOrderTitle: string; cancelOrderMessageTemplate: string;
  recordPayment: string; payable: string; paymentAmount: string;
  paymentDate: string; referenceNumber: string; notes: string; account: string;
  confirmPaymentTitle: string; confirmPaymentMessageTemplate: string; remainingPayable: string;
  save: string; cancel: string; confirm: string; loading: string;
  errors: Record<string, string>;
}

export function PurchaseDetailActions({
  locale, currency, purchaseOrderId, purchaseOrderNumber, supplierId, supplierName,
  payableRemaining, accounts, canConfirm, canCancel, canPay, labels,
}: {
  locale: Locale;
  currency: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierId: string;
  supplierName: string;
  /** grandTotal - additionalCostTotal - paidAmount, in minor units. Never negative (capped by the service itself). */
  payableRemaining: number;
  accounts: { id: string; name: string }[];
  canConfirm: boolean;
  canCancel: boolean;
  canPay: boolean;
  labels: PurchaseDetailActionsLabels;
}) {
  const router = useRouter();

  // --- Confirm order ---
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const confirmRef = useRef(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function handleConfirm() {
    if (confirmRef.current) return;
    confirmRef.current = true;
    setConfirmSubmitting(true);
    const fd = new FormData();
    fd.set("purchaseOrderId", purchaseOrderId);
    try {
      const res = await confirmPurchaseOrderAction(fd);
      if (res.ok) {
        setConfirmError(null);
        router.refresh();
      } else {
        setConfirmError(res.error);
      }
    } catch (error) {
      console.error("Confirm purchase order request failed:", error);
      setConfirmError("errors.generic");
    } finally {
      confirmRef.current = false;
      setConfirmSubmitting(false);
    }
  }

  // --- Cancel order (requires a reason — ConfirmDialog's `field` prop). ---
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const cancelRef = useRef(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function handleCancel() {
    if (cancelRef.current || reason.trim() === "") return;
    cancelRef.current = true;
    setCancelSubmitting(true);
    const fd = new FormData();
    fd.set("purchaseOrderId", purchaseOrderId);
    fd.set("reason", reason);
    try {
      const res = await cancelPurchaseOrderAction(fd);
      if (res.ok) {
        setCancelOpen(false);
        setReason("");
        setCancelError(null);
        router.refresh();
      } else {
        setCancelError(res.error);
      }
    } catch (error) {
      console.error("Cancel purchase order request failed:", error);
      setCancelError("errors.generic");
    } finally {
      cancelRef.current = false;
      setCancelSubmitting(false);
    }
  }

  // --- Record supplier payment ---
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paySubmitting, setPaySubmitting] = useState(false);
  const payRef = useRef(false);
  const [payError, setPayError] = useState<string | null>(null);

  const remainingDisplay = fromMinor(payableRemaining);
  const amountNum = Number(amount);
  // Client-side cap mirrors recordSupplierPayment's own PAYMENT_EXCEEDS_TOTAL
  // guard (payable - paidAmount, computed server-side too) — this only stops
  // the obvious case before a round trip; the service is still the source of
  // truth.
  const canSubmitPayment = !!accountId && amount.trim() !== ""
    && Number.isFinite(amountNum) && amountNum > 0 && amountNum <= remainingDisplay + 1e-9;

  async function handlePay() {
    if (payRef.current) return;
    payRef.current = true;
    setPaySubmitting(true);
    const fd = new FormData();
    fd.set("supplierId", supplierId);
    fd.set("purchaseOrderId", purchaseOrderId);
    fd.set("accountId", accountId);
    fd.set("amount", amount);
    if (paymentDate) fd.set("paymentDate", paymentDate);
    if (referenceNumber) fd.set("referenceNumber", referenceNumber);
    if (payNotes) fd.set("notes", payNotes);
    try {
      const res = await recordSupplierPaymentAction(fd);
      if (res.ok) {
        setAmount("");
        setReferenceNumber("");
        setPayNotes("");
        setPayError(null);
        router.refresh();
      } else {
        setPayError(res.error);
      }
    } catch (error) {
      console.error("Record supplier payment request failed:", error);
      setPayError("errors.generic");
    } finally {
      payRef.current = false;
      setPaySubmitting(false);
    }
  }

  const paymentConfirmMessage = fillTemplate(labels.confirmPaymentMessageTemplate, {
    amount: Number.isFinite(amountNum) ? formatMoney(toMinor(amountNum), locale, currency) : amount,
    supplier: supplierName,
  });
  const cancelConfirmMessage = fillTemplate(labels.cancelOrderMessageTemplate, {
    number: purchaseOrderNumber,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {canConfirm ? (
          <ConfirmDialog
            triggerLabel={confirmSubmitting ? labels.loading : labels.confirmOrder}
            title={labels.confirmOrderTitle}
            message={labels.confirmOrderMessage}
            confirmLabel={labels.confirm}
            cancelLabel={labels.cancel}
            tone="brand"
            onConfirmAction={handleConfirm}
            disabled={confirmSubmitting}
          />
        ) : null}
        {canCancel ? (
          <ConfirmDialog
            triggerLabel={labels.cancelOrder}
            title={labels.cancelOrderTitle}
            message={cancelConfirmMessage}
            confirmLabel={labels.confirm}
            cancelLabel={labels.cancel}
            onConfirmAction={handleCancel}
            disabled={cancelSubmitting}
            field={{
              label: labels.cancelReason,
              value: reason,
              onChange: setReason,
              type: "textarea",
              required: true,
            }}
            error={cancelError ? (labels.errors[cancelError] ?? labels.errors["errors.generic"]) : null}
            open={cancelOpen}
            onOpenChangeAction={(next) => {
              setCancelOpen(next);
              if (!next) { setReason(""); setCancelError(null); }
            }}
          />
        ) : null}
      </div>
      {confirmError ? <p className="text-sm text-danger">{labels.errors[confirmError] ?? labels.errors["errors.generic"]}</p> : null}

      {canPay ? (
        <div className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">{labels.recordPayment}</h2>
          <div className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <span className="text-muted">{labels.remainingPayable}: </span>
            <span className="font-medium">{formatMoney(payableRemaining, locale, currency)}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label={labels.account} required>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.paymentAmount} required>
              <input
                type="number" min={0} max={remainingDisplay > 0 ? remainingDisplay : undefined} step="0.01"
                value={amount} onChange={(e) => setAmount(e.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label={labels.paymentDate}>
              <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputClass} />
            </FormField>
            <FormField label={labels.referenceNumber}>
              <input
                type="text" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)}
                className={inputClass}
              />
            </FormField>
          </div>
          <div className="mt-3">
            <FormField label={labels.notes}>
              <textarea rows={2} value={payNotes} onChange={(e) => setPayNotes(e.target.value)} className={inputClass} />
            </FormField>
          </div>
          {payError ? <p className="mt-2 text-sm text-danger">{labels.errors[payError] ?? labels.errors["errors.generic"]}</p> : null}
          <div className="mt-3">
            {canSubmitPayment ? (
              <ConfirmDialog
                triggerLabel={paySubmitting ? labels.loading : labels.recordPayment}
                title={labels.confirmPaymentTitle}
                message={paymentConfirmMessage}
                confirmLabel={labels.confirm}
                cancelLabel={labels.cancel}
                tone="brand"
                onConfirmAction={handlePay}
                disabled={paySubmitting}
              />
            ) : (
              <button type="button" disabled className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink opacity-60">
                {labels.recordPayment}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

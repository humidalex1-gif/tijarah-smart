"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelSaleAction } from "../actions";
// Imported cross-feature on purpose: recordCustomerPaymentAction is defined
// once, in finance/actions.ts. Mirrors PurchaseDetailActions.tsx, which
// imports recordSupplierPaymentAction from the same place.
import { recordCustomerPaymentAction } from "../../finance/actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField, inputClass } from "@/components/ui/FormField";
import { fillTemplate } from "@/lib/i18n";
import { formatMoney } from "@/lib/format";
import { fromMinor, toMinor } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export interface SaleDetailActionsLabels {
  cancelOrder: string; cancelReason: string; cancelOrderTitle: string; cancelWarningTemplate: string;
  recordPayment: string; remainingBalance: string; paymentAmount: string;
  paymentDate: string; referenceNumber: string; notes: string; account: string;
  confirmPaymentTitle: string; confirmPaymentMessageTemplate: string;
  printInvoice: string;
  save: string; cancel: string; confirm: string; loading: string;
  errors: Record<string, string>;
}

export function SaleDetailActions({
  locale, currency, salesOrderId, customerId, customerName,
  cancelWarningUnits, cancelWarningWarehouse, remainingBalance, accounts,
  canCancel, canPay, labels,
}: {
  locale: Locale;
  currency: string;
  salesOrderId: string;
  customerId: string | null;
  customerName: string;
  cancelWarningUnits: string;
  cancelWarningWarehouse: string;
  /** grandTotal - paidAmount, in minor units. Never negative. */
  remainingBalance: number;
  accounts: { id: string; name: string }[];
  canCancel: boolean;
  canPay: boolean;
  labels: SaleDetailActionsLabels;
}) {
  const router = useRouter();

  // --- Cancel sale (requires a reason — ConfirmDialog's `field` prop). ---
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
    fd.set("salesOrderId", salesOrderId);
    fd.set("reason", reason);
    try {
      const res = await cancelSaleAction(fd);
      if (res.ok) {
        setCancelOpen(false);
        setReason("");
        setCancelError(null);
        router.refresh();
      } else {
        setCancelError(res.error);
      }
    } catch (error) {
      console.error("Cancel sale request failed:", error);
      setCancelError("errors.generic");
    } finally {
      cancelRef.current = false;
      setCancelSubmitting(false);
    }
  }

  // --- Record payment ---
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paySubmitting, setPaySubmitting] = useState(false);
  const payRef = useRef(false);
  const [payError, setPayError] = useState<string | null>(null);

  const remainingDisplay = fromMinor(remainingBalance);
  const amountNum = Number(amount);
  // Compared in the SCALED integer domain (toMinor), never as raw floats —
  // `amountNum <= remainingDisplay + 1e-9` (the epsilon-fudged float
  // comparison this used to be) can both wrongly admit an amount a halala
  // over the cap and wrongly reject one exactly at it, depending on
  // floating-point rounding of the decimal string. Same rule as every
  // quantity/amount comparison elsewhere (money.ts's own doc comment).
  const canSubmitPayment = !!accountId && !!customerId && amount.trim() !== ""
    && Number.isFinite(amountNum) && amountNum > 0 && toMinor(amount) <= remainingBalance;

  async function handlePay() {
    if (payRef.current || !customerId) return;
    payRef.current = true;
    setPaySubmitting(true);
    const fd = new FormData();
    fd.set("customerId", customerId);
    fd.set("salesOrderId", salesOrderId);
    fd.set("accountId", accountId);
    fd.set("amount", amount);
    if (paymentDate) fd.set("paymentDate", paymentDate);
    if (referenceNumber) fd.set("referenceNumber", referenceNumber);
    if (payNotes) fd.set("notes", payNotes);
    try {
      const res = await recordCustomerPaymentAction(fd);
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
      console.error("Record customer payment request failed:", error);
      setPayError("errors.generic");
    } finally {
      payRef.current = false;
      setPaySubmitting(false);
    }
  }

  const paymentConfirmMessage = fillTemplate(labels.confirmPaymentMessageTemplate, {
    amount: Number.isFinite(amountNum) ? formatMoney(toMinor(amountNum), locale, currency) : amount,
    customer: customerName,
  });
  const cancelWarningMessage = fillTemplate(labels.cancelWarningTemplate, {
    units: cancelWarningUnits, warehouse: cancelWarningWarehouse,
  });

  return (
    <div className="space-y-6 print:hidden">
      <div className="flex flex-wrap gap-2">
        {canCancel ? (
          <ConfirmDialog
            triggerLabel={labels.cancelOrder}
            title={labels.cancelOrderTitle}
            message={cancelWarningMessage}
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
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface"
        >
          {labels.printInvoice}
        </button>
      </div>

      {canPay && customerId ? (
        <div className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">{labels.recordPayment}</h2>
          <div className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <span className="text-muted">{labels.remainingBalance}: </span>
            <span className="font-medium">{formatMoney(remainingBalance, locale, currency)}</span>
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

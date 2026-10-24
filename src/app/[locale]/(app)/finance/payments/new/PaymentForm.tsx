"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  recordCustomerPaymentAction, recordSupplierPaymentAction, transferBetweenAccountsAction,
} from "../../actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField, inputClass } from "@/components/ui/FormField";
import { DocumentField } from "@/components/ui/DocumentField";
import { fillTemplate } from "@/lib/i18n";
import { formatMoney } from "@/lib/format";
import { fromMinor, toMinor } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

type Mode = "CUSTOMER" | "SUPPLIER" | "TRANSFER";

export interface PaymentFormLabels {
  paymentType: string;
  customerPayment: string; supplierPayment: string; transfer: string;
  customer: string; supplier: string; order: string; account: string;
  fromAccount: string; toAccount: string;
  amount: string; paymentDate: string; referenceNumber: string; notes: string;
  save: string; cancel: string; confirm: string; loading: string;
  confirmPaymentTitle: string;
  confirmCustomerMessageTemplate: string; confirmSupplierMessageTemplate: string;
  confirmTransferTitle: string; confirmTransferMessageTemplate: string;
  remaining: string;
  document: string; documentHint: string; documentClear: string;
  errors: Record<string, string>;
}

export function PaymentForm({
  locale, currency, showSupplierTab, showTransferTab,
  customers, salesOrders, suppliers, purchaseOrders, accounts, labels,
}: {
  locale: Locale;
  currency: string;
  /** Gated at construction time on the caller's own purchases.view — the page never fetches supplier/PO data otherwise. */
  showSupplierTab: boolean;
  /** Gated at construction time on the caller's own finance.manage_accounts. */
  showTransferTab: boolean;
  customers: { id: string; name: string }[];
  salesOrders: { id: string; orderNumber: string; customerId: string; grandTotal: number; paidAmount: number }[];
  suppliers: { id: string; name: string }[];
  purchaseOrders: {
    id: string; orderNumber: string; supplierId: string;
    grandTotal: number; additionalCostTotal: number; paidAmount: number;
  }[];
  accounts: { id: string; name: string }[];
  labels: PaymentFormLabels;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("CUSTOMER");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // --- Customer payment ---
  const [customerId, setCustomerId] = useState("");
  const [salesOrderId, setSalesOrderId] = useState("");
  const [custAccountId, setCustAccountId] = useState(accounts[0]?.id ?? "");
  const [custAmount, setCustAmount] = useState("");
  const [custDate, setCustDate] = useState("");
  const [custRef, setCustRef] = useState("");
  const [custNotes, setCustNotes] = useState("");
  const [custFile, setCustFile] = useState<File | null>(null);

  const customerOrders = useMemo(
    () => salesOrders.filter((o) => o.customerId === customerId),
    [salesOrders, customerId],
  );
  const selectedSalesOrder = customerOrders.find((o) => o.id === salesOrderId);
  const custRemaining = selectedSalesOrder ? selectedSalesOrder.grandTotal - selectedSalesOrder.paidAmount : undefined;
  const custAmountNum = Number(custAmount);
  const canSubmitCustomer = !!customerId && !!custAccountId && custAmount.trim() !== ""
    && Number.isFinite(custAmountNum) && custAmountNum > 0
    && (custRemaining === undefined || toMinor(custAmount) <= custRemaining);

  // --- Supplier payment ---
  const [supplierId, setSupplierId] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [supAccountId, setSupAccountId] = useState(accounts[0]?.id ?? "");
  const [supAmount, setSupAmount] = useState("");
  const [supDate, setSupDate] = useState("");
  const [supRef, setSupRef] = useState("");
  const [supNotes, setSupNotes] = useState("");
  const [supFile, setSupFile] = useState<File | null>(null);

  const supplierOrders = useMemo(
    () => purchaseOrders.filter((o) => o.supplierId === supplierId),
    [purchaseOrders, supplierId],
  );
  const selectedPurchaseOrder = supplierOrders.find((o) => o.id === purchaseOrderId);
  const supRemaining = selectedPurchaseOrder
    ? selectedPurchaseOrder.grandTotal - selectedPurchaseOrder.additionalCostTotal - selectedPurchaseOrder.paidAmount
    : undefined;
  const supAmountNum = Number(supAmount);
  const canSubmitSupplier = !!supplierId && !!supAccountId && supAmount.trim() !== ""
    && Number.isFinite(supAmountNum) && supAmountNum > 0
    && (supRemaining === undefined || toMinor(supAmount) <= supRemaining);

  // --- Transfer ---
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(accounts[1]?.id ?? "");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNotes, setTransferNotes] = useState("");
  const transferAmountNum = Number(transferAmount);
  const canSubmitTransfer = !!fromAccountId && !!toAccountId && fromAccountId !== toAccountId
    && transferAmount.trim() !== "" && Number.isFinite(transferAmountNum) && transferAmountNum > 0;

  function accountName(id: string) {
    return accounts.find((a) => a.id === id)?.name ?? "";
  }
  function customerName(id: string) {
    return customers.find((c) => c.id === id)?.name ?? "";
  }
  function supplierName(id: string) {
    return suppliers.find((s) => s.id === id)?.name ?? "";
  }

  async function handleCustomerSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("customerId", customerId);
    if (salesOrderId) fd.set("salesOrderId", salesOrderId);
    fd.set("accountId", custAccountId);
    fd.set("amount", custAmount);
    if (custDate) fd.set("paymentDate", custDate);
    if (custRef) fd.set("referenceNumber", custRef);
    if (custNotes) fd.set("notes", custNotes);
    if (custFile) fd.set("file", custFile);
    try {
      const res = await recordCustomerPaymentAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/finance/transactions`);
    } catch (error) {
      console.error("Record customer payment request failed:", error);
      setResult({ ok: false, error: "errors.generic" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleSupplierSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("supplierId", supplierId);
    if (purchaseOrderId) fd.set("purchaseOrderId", purchaseOrderId);
    fd.set("accountId", supAccountId);
    fd.set("amount", supAmount);
    if (supDate) fd.set("paymentDate", supDate);
    if (supRef) fd.set("referenceNumber", supRef);
    if (supNotes) fd.set("notes", supNotes);
    if (supFile) fd.set("file", supFile);
    try {
      const res = await recordSupplierPaymentAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/finance/transactions`);
    } catch (error) {
      console.error("Record supplier payment request failed:", error);
      setResult({ ok: false, error: "errors.generic" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleTransferSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("fromAccountId", fromAccountId);
    fd.set("toAccountId", toAccountId);
    fd.set("amount", transferAmount);
    if (transferNotes) fd.set("notes", transferNotes);
    try {
      const res = await transferBetweenAccountsAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/finance/transactions`);
    } catch (error) {
      console.error("Transfer between accounts request failed:", error);
      setResult({ ok: false, error: "errors.generic" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const customerConfirmMessage = fillTemplate(labels.confirmCustomerMessageTemplate, {
    amount: Number.isFinite(custAmountNum) ? formatMoney(toMinor(custAmount), locale, currency) : custAmount,
    customer: customerName(customerId),
  });
  const supplierConfirmMessage = fillTemplate(labels.confirmSupplierMessageTemplate, {
    amount: Number.isFinite(supAmountNum) ? formatMoney(toMinor(supAmount), locale, currency) : supAmount,
    supplier: supplierName(supplierId),
  });
  const transferConfirmMessage = fillTemplate(labels.confirmTransferMessageTemplate, {
    amount: Number.isFinite(transferAmountNum) ? formatMoney(toMinor(transferAmount), locale, currency) : transferAmount,
    from: accountName(fromAccountId),
    to: accountName(toAccountId),
  });

  const tabs: { key: Mode; label: string }[] = [
    { key: "CUSTOMER", label: labels.customerPayment },
    ...(showSupplierTab ? [{ key: "SUPPLIER" as const, label: labels.supplierPayment }] : []),
    ...(showTransferTab ? [{ key: "TRANSFER" as const, label: labels.transfer }] : []),
  ];

  // Defensive against the (currently unreachable, since the buttons below
  // are the only way to change `mode`) case of a hidden tab's mode staying
  // selected — the SUPPLIER/TRANSFER sections below are also individually
  // gated on these same flags, so this only prevents a blank screen if that
  // ever changes.
  const effectiveMode = (mode === "SUPPLIER" && !showSupplierTab) || (mode === "TRANSFER" && !showTransferTab)
    ? "CUSTOMER"
    : mode;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => { setMode(tab.key); setResult(null); }}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              mode === tab.key ? "border-brand bg-brand text-brand-ink" : "border-line bg-panel text-navy hover:bg-surface"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {effectiveMode === "CUSTOMER" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label={labels.customer} required>
              <select
                value={customerId}
                onChange={(e) => { setCustomerId(e.target.value); setSalesOrderId(""); }}
                className={inputClass}
              >
                <option value="">—</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.order}>
              <select value={salesOrderId} onChange={(e) => setSalesOrderId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {customerOrders.map((o) => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
              </select>
            </FormField>
            <FormField label={labels.account} required>
              <select value={custAccountId} onChange={(e) => setCustAccountId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.amount} required>
              <input
                type="number" min={0}
                max={custRemaining !== undefined ? fromMinor(custRemaining) : undefined}
                step="0.01" value={custAmount} onChange={(e) => setCustAmount(e.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label={labels.paymentDate}>
              <input type="date" value={custDate} onChange={(e) => setCustDate(e.target.value)} className={inputClass} />
            </FormField>
            <FormField label={labels.referenceNumber}>
              <input type="text" value={custRef} onChange={(e) => setCustRef(e.target.value)} className={inputClass} />
            </FormField>
          </div>
          {custRemaining !== undefined ? (
            <p className="text-xs text-muted">
              {labels.remaining}: {formatMoney(custRemaining, locale, currency)}
            </p>
          ) : null}
          <FormField label={labels.notes}>
            <textarea rows={2} value={custNotes} onChange={(e) => setCustNotes(e.target.value)} className={inputClass} />
          </FormField>

          {/* The receipt behind the payment, uploaded with it rather than in
              a second step somebody has to remember. */}
          <DocumentField
            label={labels.document} hint={labels.documentHint} clearLabel={labels.documentClear}
            onChange={setCustFile} disabled={submitting}
          />
          {result && !result.ok ? (
            <p className="text-sm text-danger">{labels.errors[result.error!] ?? labels.errors["errors.generic"]}</p>
          ) : null}
          <div className="flex gap-2">
            {canSubmitCustomer ? (
              <ConfirmDialog
                triggerLabel={submitting ? labels.loading : labels.save}
                title={labels.confirmPaymentTitle}
                message={customerConfirmMessage}
                confirmLabel={labels.confirm}
                cancelLabel={labels.cancel}
                tone="brand"
                onConfirmAction={handleCustomerSubmit}
                disabled={submitting}
              />
            ) : (
              <button type="button" disabled className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink opacity-60">
                {labels.save}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {effectiveMode === "SUPPLIER" && showSupplierTab ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label={labels.supplier} required>
              <select
                value={supplierId}
                onChange={(e) => { setSupplierId(e.target.value); setPurchaseOrderId(""); }}
                className={inputClass}
              >
                <option value="">—</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.order}>
              <select value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {supplierOrders.map((o) => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
              </select>
            </FormField>
            <FormField label={labels.account} required>
              <select value={supAccountId} onChange={(e) => setSupAccountId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.amount} required>
              <input
                type="number" min={0}
                max={supRemaining !== undefined ? fromMinor(supRemaining) : undefined}
                step="0.01" value={supAmount} onChange={(e) => setSupAmount(e.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label={labels.paymentDate}>
              <input type="date" value={supDate} onChange={(e) => setSupDate(e.target.value)} className={inputClass} />
            </FormField>
            <FormField label={labels.referenceNumber}>
              <input type="text" value={supRef} onChange={(e) => setSupRef(e.target.value)} className={inputClass} />
            </FormField>
          </div>
          {supRemaining !== undefined ? (
            <p className="text-xs text-muted">
              {labels.remaining}: {formatMoney(supRemaining, locale, currency)}
            </p>
          ) : null}
          <FormField label={labels.notes}>
            <textarea rows={2} value={supNotes} onChange={(e) => setSupNotes(e.target.value)} className={inputClass} />
          </FormField>

          <DocumentField
            label={labels.document} hint={labels.documentHint} clearLabel={labels.documentClear}
            onChange={setSupFile} disabled={submitting}
          />
          {result && !result.ok ? (
            <p className="text-sm text-danger">{labels.errors[result.error!] ?? labels.errors["errors.generic"]}</p>
          ) : null}
          <div className="flex gap-2">
            {canSubmitSupplier ? (
              <ConfirmDialog
                triggerLabel={submitting ? labels.loading : labels.save}
                title={labels.confirmPaymentTitle}
                message={supplierConfirmMessage}
                confirmLabel={labels.confirm}
                cancelLabel={labels.cancel}
                tone="brand"
                onConfirmAction={handleSupplierSubmit}
                disabled={submitting}
              />
            ) : (
              <button type="button" disabled className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink opacity-60">
                {labels.save}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {effectiveMode === "TRANSFER" && showTransferTab ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label={labels.fromAccount} required>
              <select value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.toAccount} required>
              <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField
              label={labels.amount} required
              error={fromAccountId && toAccountId && fromAccountId === toAccountId
                ? labels.errors["errors.SAME_ACCOUNT"] : undefined}
            >
              <input
                type="number" min={0} step="0.01" value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                className={inputClass}
              />
            </FormField>
          </div>
          <FormField label={labels.notes}>
            <textarea rows={2} value={transferNotes} onChange={(e) => setTransferNotes(e.target.value)} className={inputClass} />
          </FormField>
          {result && !result.ok ? (
            <p className="text-sm text-danger">{labels.errors[result.error!] ?? labels.errors["errors.generic"]}</p>
          ) : null}
          <div className="flex gap-2">
            {canSubmitTransfer ? (
              <ConfirmDialog
                triggerLabel={submitting ? labels.loading : labels.save}
                title={labels.confirmTransferTitle}
                message={transferConfirmMessage}
                confirmLabel={labels.confirm}
                cancelLabel={labels.cancel}
                tone="brand"
                onConfirmAction={handleTransferSubmit}
                disabled={submitting}
              />
            ) : (
              <button type="button" disabled className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink opacity-60">
                {labels.save}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

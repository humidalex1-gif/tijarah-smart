"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { addExpenseAction } from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { DocumentField } from "@/components/ui/DocumentField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";
import { formatMoney } from "@/lib/format";
import { toMinor } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export interface ExpenseFormLabels {
  category: string; amount: string; tax: string; date: string; account: string;
  supplier: string; warehouse: string; description: string; notes: string;
  save: string; cancel: string; confirm: string; loading: string;
  createConfirmTitle: string; createConfirmMessageTemplate: string;
  document: string; documentHint: string; documentClear: string;
  errors: Record<string, string>;
}

export function ExpenseForm({
  locale, currency, categories, accounts, suppliers, warehouses, labels,
}: {
  locale: Locale;
  currency: string;
  categories: { id: string; nameAr: string; nameEn: string }[];
  accounts: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  warehouses: { id: string; name: string }[];
  labels: ExpenseFormLabels;
}) {
  const router = useRouter();

  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [taxAmount, setTaxAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof addExpenseAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE — two confirms fired synchronously
  // in the same tick both read the same stale, pre-update `submitting`
  // closure value, so a state-only check does not block the second one. Same
  // pattern as every other Task 6-9 mutation form.
  const submittingRef = useRef(false);

  const accountName = useMemo(
    () => accounts.find((a) => a.id === accountId)?.name ?? "",
    [accounts, accountId],
  );

  const amountNum = Number(amount);
  const taxNum = taxAmount.trim() !== "" ? Number(taxAmount) : 0;
  const totalMinor = amount.trim() !== "" && Number.isFinite(amountNum) && Number.isFinite(taxNum)
    ? toMinor(amountNum) + toMinor(taxNum)
    : 0;

  const canSubmit = !!categoryId && !!accountId && description.trim() !== ""
    && amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0
    && (taxAmount.trim() === "" || (Number.isFinite(taxNum) && taxNum >= 0));

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("categoryId", categoryId);
    fd.set("accountId", accountId);
    if (supplierId) fd.set("supplierId", supplierId);
    if (warehouseId) fd.set("warehouseId", warehouseId);
    if (expenseDate) fd.set("expenseDate", expenseDate);
    fd.set("description", description);
    fd.set("amount", amount);
    if (taxAmount) fd.set("taxAmount", taxAmount);
    if (notes) fd.set("notes", notes);
    // Only when one was chosen: an empty File would fail the size guard in
    // saveUpload and refuse an expense that never wanted a document.
    if (file) fd.set("file", file);
    try {
      const res = await addExpenseAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/expenses/${res.data.expenseId}`);
    } catch (error) {
      console.error("Add expense request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const confirmMessage = fillTemplate(labels.createConfirmMessageTemplate, {
    amount: amount.trim() !== "" && Number.isFinite(amountNum)
      ? formatMoney(totalMinor, locale, currency)
      : amount,
    account: accountName,
  });

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label={labels.category} required>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{locale === "ar" ? c.nameAr : c.nameEn}</option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.account} required>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </FormField>
        <FormField label={labels.amount} required>
          <input
            type="number" min={0} step="0.01" value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.tax}>
          <input
            type="number" min={0} step="0.01" value={taxAmount}
            onChange={(e) => setTaxAmount(e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.date}>
          <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.supplier}>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </FormField>
        <FormField label={labels.warehouse}>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </FormField>
      </div>

      <FormField label={labels.description} required>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
      </FormField>
      <FormField label={labels.notes}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </FormField>

      {/* Uploaded with the save, not before it: picking a file and then
          abandoning the form must leave nothing behind. */}
      <DocumentField
        label={labels.document}
        hint={labels.documentHint}
        clearLabel={labels.documentClear}
        onChange={setFile}
        disabled={submitting}
      />

      {result && !result.ok ? (
        <p className="text-sm text-danger">{labels.errors[result.error] ?? labels.errors["errors.generic"]}</p>
      ) : null}

      <div className="flex gap-2">
        {canSubmit ? (
          <ConfirmDialog
            triggerLabel={submitting ? labels.loading : labels.save}
            title={labels.createConfirmTitle}
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

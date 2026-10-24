"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createAccountAction } from "../actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField, inputClass } from "@/components/ui/FormField";
import type { AccountType } from "@/lib/constants";

export interface AddAccountFormLabels {
  accountName: string; accountType: string; openingBalance: string;
  accountTypeOptions: Record<AccountType, string>;
  addAccount: string; save: string; cancel: string; confirm: string; loading: string;
  addAccountConfirmTitle: string; addAccountConfirmMessage: string;
  errors: Record<string, string>;
}

export function AddAccountForm({ labels }: { labels: AddAccountFormLabels }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("CASH");
  const [openingBalance, setOpeningBalance] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof createAccountAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const canSubmit = name.trim() !== "";

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("name", name);
    fd.set("accountType", accountType);
    if (openingBalance) fd.set("openingBalance", openingBalance);
    try {
      const res = await createAccountAction(fd);
      setResult(res);
      if (res.ok) {
        setName("");
        setOpeningBalance("");
        setOpen(false);
        router.refresh();
      }
    } catch (error) {
      console.error("Add account request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
      >
        {labels.addAccount}
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold">{labels.addAccount}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label={labels.accountName} required>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.accountType} required>
          <select
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
            className={inputClass}
          >
            {(Object.keys(labels.accountTypeOptions) as AccountType[]).map((t) => (
              <option key={t} value={t}>{labels.accountTypeOptions[t]}</option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.openingBalance}>
          <input
            type="number" min={0} step="0.01" value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>
      {result && !result.ok ? (
        <p className="mt-2 text-sm text-danger">{labels.errors[result.error] ?? labels.errors["errors.generic"]}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        {canSubmit ? (
          <ConfirmDialog
            triggerLabel={submitting ? labels.loading : labels.save}
            title={labels.addAccountConfirmTitle}
            message={labels.addAccountConfirmMessage}
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
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-4 py-2 text-sm">
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}

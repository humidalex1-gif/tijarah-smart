"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateCompanySettingsAction } from "./actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField, inputClass } from "@/components/ui/FormField";

export interface CompanySettingsFormLabels {
  name: string; legalName: string; phone: string; email: string; address: string; taxNumber: string;
  currency: string; defaultTaxRate: string; timezone: string; negativeInventory: string;
  timezoneHint: string; currencyLockedHint: string;
  save: string; cancel: string; confirm: string; loading: string;
  saveConfirmTitle: string; saveConfirmMessage: string;
  errors: Record<string, string>;
}

export interface CompanySettingsFormDefaults {
  name: string; legalName: string; phone: string; email: string; address: string; taxNumber: string;
  // Percent as a decimal string ("15" for 15%), not basis points — matches
  // the onboarding form's identically shaped defaultTaxRatePct/100 display.
  currencyCode: string; defaultTaxRatePct: string; timezone: string; allowNegativeInventory: boolean;
}

export function CompanySettingsForm({
  defaults, canEdit, currencyLocked, labels,
}: {
  defaults: CompanySettingsFormDefaults;
  canEdit: boolean;
  /** True once any Payment/Expense/SalesOrder/PurchaseOrder exists for the company — see hasFinancialActivity (src/services/company.ts). */
  currencyLocked: boolean;
  labels: CompanySettingsFormLabels;
}) {
  const router = useRouter();
  const [values, setValues] = useState<CompanySettingsFormDefaults>(defaults);
  const [result, setResult] = useState<Awaited<ReturnType<typeof updateCompanySettingsAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function set<K extends keyof CompanySettingsFormDefaults>(key: K, value: CompanySettingsFormDefaults[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("name", values.name);
    fd.set("legalName", values.legalName);
    fd.set("phone", values.phone);
    fd.set("email", values.email);
    fd.set("address", values.address);
    fd.set("taxNumber", values.taxNumber);
    fd.set("currencyCode", values.currencyCode);
    fd.set("defaultTaxRatePct", values.defaultTaxRatePct);
    fd.set("timezone", values.timezone);
    // Always set, never omitted — CompanySettingsAction's schema relies on
    // this being the literal string "true"/"false", not an uncontrolled
    // checkbox's all-or-nothing presence.
    fd.set("allowNegativeInventory", String(values.allowNegativeInventory));
    try {
      const res = await updateCompanySettingsAction(fd);
      setResult(res);
      if (res.ok) router.refresh();
    } catch (error) {
      console.error("Update company settings request failed:", error);
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

  return (
    <div className="max-w-2xl space-y-4">
      <fieldset disabled={!canEdit} className="space-y-4 disabled:opacity-70">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={labels.name} error={fieldError("name")}>
            <input type="text" value={values.name} onChange={(e) => set("name", e.target.value)} className={inputClass} />
          </FormField>
          <FormField label={labels.legalName} error={fieldError("legalName")}>
            <input
              type="text" value={values.legalName} onChange={(e) => set("legalName", e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label={labels.phone} error={fieldError("phone")}>
            <input type="text" value={values.phone} onChange={(e) => set("phone", e.target.value)} className={inputClass} />
          </FormField>
          <FormField label={labels.email} error={fieldError("email")}>
            <input type="email" value={values.email} onChange={(e) => set("email", e.target.value)} className={inputClass} />
          </FormField>
          <FormField label={labels.taxNumber} error={fieldError("taxNumber")}>
            <input
              type="text" value={values.taxNumber} onChange={(e) => set("taxNumber", e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField
            label={labels.currency} error={fieldError("currencyCode")}
            hint={currencyLocked ? labels.currencyLockedHint : undefined}
          >
            <input
              type="text" maxLength={3} value={values.currencyCode} disabled={currencyLocked}
              onChange={(e) => set("currencyCode", e.target.value.toUpperCase())}
              className={`${inputClass} uppercase disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted`}
            />
          </FormField>
          <FormField label={labels.defaultTaxRate} error={fieldError("defaultTaxRatePct")}>
            <input
              type="number" min={0} max={100} step="0.01" value={values.defaultTaxRatePct}
              onChange={(e) => set("defaultTaxRatePct", e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label={labels.timezone} error={fieldError("timezone")} hint={labels.timezoneHint}>
            <input
              type="text" value={values.timezone} onChange={(e) => set("timezone", e.target.value)}
              className={inputClass}
            />
          </FormField>
        </div>

        <FormField label={labels.address} error={fieldError("address")}>
          <input type="text" value={values.address} onChange={(e) => set("address", e.target.value)} className={inputClass} />
        </FormField>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox" checked={values.allowNegativeInventory}
            onChange={(e) => set("allowNegativeInventory", e.target.checked)}
          />
          {labels.negativeInventory}
        </label>
      </fieldset>

      {result && !result.ok && result.code !== "VALIDATION" ? (
        <p className="text-sm text-danger">{labels.errors[result.error] ?? labels.errors["errors.generic"]}</p>
      ) : null}

      {canEdit ? (
        <div className="flex gap-2">
          <ConfirmDialog
            triggerLabel={submitting ? labels.loading : labels.save}
            title={labels.saveConfirmTitle}
            message={labels.saveConfirmMessage}
            confirmLabel={labels.confirm}
            cancelLabel={labels.cancel}
            tone="brand"
            onConfirmAction={handleSubmit}
            disabled={submitting}
          />
        </div>
      ) : null}
    </div>
  );
}

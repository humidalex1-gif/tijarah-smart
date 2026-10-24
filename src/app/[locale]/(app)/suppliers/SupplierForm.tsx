"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupplierAction, updateSupplierAction } from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { Locale } from "@/lib/i18n";

export interface SupplierFormLabels {
  name: string; companyName: string; contactPerson: string; phone: string; email: string;
  country: string; city: string; address: string; taxNumber: string; paymentTermsDays: string;
  notes: string;
  save: string; cancel: string;
  errors: Record<string, string>;
}

export interface SupplierFormDefaults {
  name: string; companyName: string; contactPerson: string; phone: string; email: string;
  country: string; city: string; address: string; taxNumber: string; paymentTermsDays: string;
  notes: string;
}

export function SupplierForm({
  locale, mode, supplierId, defaults, labels, onSavedAction, onCancelAction,
}: {
  locale: Locale;
  mode: "create" | "edit";
  supplierId?: string;
  defaults: SupplierFormDefaults;
  labels: SupplierFormLabels;
  /** Edit mode stays on the same detail page and refreshes it instead of navigating away. */
  onSavedAction?: () => void;
  /** Inline edit (SupplierEditSection) closes the section instead of navigating with router.back(). */
  onCancelAction?: () => void;
}) {
  const router = useRouter();
  const rawAction = mode === "create" ? createSupplierAction : updateSupplierAction;
  const [state, formAction] = useActionState(
    async (_prev: Awaited<ReturnType<typeof rawAction>> | null, formData: FormData) =>
      rawAction(formData),
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      if (mode === "create") router.push(`/${locale}/suppliers/${state.data.id}`);
      else onSavedAction?.();
    }
    // onSavedAction is a fresh closure every render from the caller — only
    // re-run this effect when the action's own result actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, router, locale, mode]);

  // Controlled, same rationale as WarehouseForm.tsx/ProductForm.tsx: React
  // resets a <form>'s uncontrolled fields to their defaults after any
  // dispatched action settles, success or failure — a validation rejection
  // would otherwise wipe everything the merchant already typed.
  const [values, setValues] = useState<SupplierFormDefaults>(defaults);
  function set<K extends keyof SupplierFormDefaults>(key: K, value: SupplierFormDefaults[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  const fieldErrors = state && !state.ok ? state.fields : undefined;
  function fieldError(name: string): string | undefined {
    const raw = fieldErrors?.[name];
    if (raw === undefined) return undefined;
    return labels.errors[raw] ?? raw;
  }

  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      {mode === "edit" ? <input type="hidden" name="id" value={supplierId} /> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label={labels.name} required error={fieldError("name")}>
          <input
            type="text" name="name" required
            value={values.name} onChange={(e) => set("name", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.companyName} error={fieldError("companyName")}>
          <input
            type="text" name="companyName"
            value={values.companyName} onChange={(e) => set("companyName", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.contactPerson} error={fieldError("contactPerson")}>
          <input
            type="text" name="contactPerson"
            value={values.contactPerson} onChange={(e) => set("contactPerson", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.phone} error={fieldError("phone")}>
          <input
            type="text" name="phone"
            value={values.phone} onChange={(e) => set("phone", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.email} error={fieldError("email")}>
          <input
            type="email" name="email"
            value={values.email} onChange={(e) => set("email", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.country} error={fieldError("country")}>
          <input
            type="text" name="country"
            value={values.country} onChange={(e) => set("country", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.city} error={fieldError("city")}>
          <input
            type="text" name="city"
            value={values.city} onChange={(e) => set("city", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.taxNumber} error={fieldError("taxNumber")}>
          <input
            type="text" name="taxNumber"
            value={values.taxNumber} onChange={(e) => set("taxNumber", e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.paymentTermsDays} error={fieldError("paymentTermsDays")}>
          <input
            type="number" name="paymentTermsDays" min={0} step="1"
            value={values.paymentTermsDays} onChange={(e) => set("paymentTermsDays", e.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>

      <FormField label={labels.address} error={fieldError("address")}>
        <input
          type="text" name="address"
          value={values.address} onChange={(e) => set("address", e.target.value)}
          className={inputClass}
        />
      </FormField>

      <FormField label={labels.notes} error={fieldError("notes")}>
        <textarea
          rows={2} name="notes"
          value={values.notes} onChange={(e) => set("notes", e.target.value)}
          className={inputClass}
        />
      </FormField>

      {state && !state.ok && state.code !== "VALIDATION" ? (
        <p className="text-sm text-danger">
          {labels.errors[state.error] ?? labels.errors["errors.generic"]}
        </p>
      ) : null}

      <div className="flex gap-2">
        <SubmitButton>{labels.save}</SubmitButton>
        <button
          type="button" onClick={() => (onCancelAction ? onCancelAction() : router.back())}
          className="rounded-lg border border-line px-4 py-2 text-sm"
        >
          {labels.cancel}
        </button>
      </div>
    </form>
  );
}

"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createStockCountAction } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { Locale } from "@/lib/i18n";

export interface NewCountFormLabels {
  warehouse: string; scope: string;
  scopeWarehouse: string; scopeCategory: string; scopeBrand: string;
  category: string; brand: string; notes: string;
  save: string; cancel: string;
  errors: Record<string, string>;
}

// MANUAL is a real scope the action supports, but its UI is a product
// picker — its own piece of work, and nothing this task needs — so it is
// deliberately absent from this union and the radio group below.
type UiScopeType = "WAREHOUSE" | "CATEGORY" | "BRAND";

export function NewCountForm({
  locale, warehouses, categories, brands, labels,
}: {
  locale: Locale;
  warehouses: { id: string; name: string }[];
  categories: { id: string; nameAr: string; nameEn: string }[];
  brands: { id: string; name: string }[];
  labels: NewCountFormLabels;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(
    async (_prev: Awaited<ReturnType<typeof createStockCountAction>> | null, formData: FormData) =>
      createStockCountAction(formData),
    null,
  );

  useEffect(() => {
    if (state?.ok) router.push(`/${locale}/inventory/counts/${state.data.sessionId}`);
  }, [state, router, locale]);

  // Controlled, same rationale as WarehouseForm.tsx/SupplierForm.tsx: React
  // resets a <form>'s uncontrolled fields to their defaults after any
  // dispatched action settles, success or failure — a validation rejection
  // would otherwise wipe everything the merchant already picked.
  const [warehouseId, setWarehouseId] = useState("");
  const [scopeType, setScopeType] = useState<UiScopeType>("WAREHOUSE");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [notes, setNotes] = useState("");

  const fieldErrors = state && !state.ok ? state.fields : undefined;
  function fieldError(name: string): string | undefined {
    const raw = fieldErrors?.[name];
    if (raw === undefined) return undefined;
    return labels.errors[raw] ?? raw;
  }

  const scopeOptions: Array<[UiScopeType, string]> = [
    ["WAREHOUSE", labels.scopeWarehouse],
    ["CATEGORY", labels.scopeCategory],
    ["BRAND", labels.scopeBrand],
  ];

  return (
    <form action={formAction} className="max-w-lg space-y-4">
      <FormField label={labels.warehouse} required error={fieldError("warehouseId")}>
        <select
          name="warehouseId" required
          value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}
          className={inputClass}
        >
          <option value="">—</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </FormField>

      <FormField label={labels.scope} required>
        <div className="flex flex-wrap gap-4">
          {scopeOptions.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="scopeType" value={value}
                checked={scopeType === value}
                onChange={() => setScopeType(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </FormField>

      {scopeType === "CATEGORY" ? (
        <FormField label={labels.category} required error={fieldError("categoryId")}>
          <select
            name="categoryId" required
            value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{locale === "ar" ? c.nameAr : c.nameEn}</option>
            ))}
          </select>
        </FormField>
      ) : null}

      {scopeType === "BRAND" ? (
        <FormField label={labels.brand} required error={fieldError("brandId")}>
          <select
            name="brandId" required
            value={brandId} onChange={(e) => setBrandId(e.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </FormField>
      ) : null}

      <FormField label={labels.notes}>
        <textarea rows={2} name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </FormField>

      {state && !state.ok && state.code !== "VALIDATION" ? (
        <p className="text-sm text-danger">
          {labels.errors[state.error] ?? labels.errors["errors.generic"]}
        </p>
      ) : null}

      <div className="flex gap-2">
        <SubmitButton>{labels.save}</SubmitButton>
        <button type="button" onClick={() => router.back()} className="rounded-lg border border-line px-4 py-2 text-sm">
          {labels.cancel}
        </button>
      </div>
    </form>
  );
}

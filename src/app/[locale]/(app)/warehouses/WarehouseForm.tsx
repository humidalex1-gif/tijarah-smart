"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createWarehouseAction, updateWarehouseAction } from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { Locale } from "@/lib/i18n";

export interface WarehouseFormLabels {
  name: string; code: string; city: string; isDefault: string;
  save: string; cancel: string;
  duplicateCode: string;
  errors: Record<string, string>;
}

export function WarehouseForm({
  locale, mode, warehouseId, defaults, labels,
}: {
  locale: Locale;
  mode: "create" | "edit";
  warehouseId?: string;
  defaults: { name: string; code: string; city: string; isDefault: boolean };
  labels: WarehouseFormLabels;
}) {
  const router = useRouter();
  const rawAction = mode === "create" ? createWarehouseAction : updateWarehouseAction;
  const [state, formAction] = useActionState(
    async (_prev: Awaited<ReturnType<typeof rawAction>> | null, formData: FormData) =>
      rawAction(formData),
    null,
  );

  useEffect(() => {
    if (state?.ok) router.push(`/${locale}/warehouses/${state.data.id}`);
  }, [state, router, locale]);

  // Controlled, same rationale as ProductForm.tsx: React resets a <form>'s
  // uncontrolled fields to their defaults after any dispatched action
  // settles, success or failure — a duplicate-code rejection would otherwise
  // wipe the name/city the merchant already typed.
  const [values, setValues] = useState({
    name: defaults.name, code: defaults.code, city: defaults.city, isDefault: defaults.isDefault,
  });
  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  const codeError = state && !state.ok && state.code === "DUPLICATE_WAREHOUSE_CODE"
    ? labels.duplicateCode
    : undefined;

  const fieldErrors = state && !state.ok ? state.fields : undefined;
  function fieldError(name: string): string | undefined {
    const raw = fieldErrors?.[name];
    if (raw === undefined) return undefined;
    return labels.errors[raw] ?? raw;
  }

  return (
    <form action={formAction} className="max-w-lg space-y-4">
      {mode === "edit" ? <input type="hidden" name="id" value={warehouseId} /> : null}

      <FormField label={labels.name} required error={fieldError("name")}>
        <input
          type="text" name="name" required
          value={values.name} onChange={(e) => set("name", e.target.value)}
          className={inputClass}
        />
      </FormField>
      <FormField label={labels.code} required error={codeError ?? fieldError("code")}>
        <input
          type="text" name="code" required
          value={values.code} onChange={(e) => set("code", e.target.value)}
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox" name="isDefault"
          checked={values.isDefault} onChange={(e) => set("isDefault", e.target.checked)}
        />
        {labels.isDefault}
      </label>

      {state && !state.ok && state.code !== "VALIDATION" && state.code !== "DUPLICATE_WAREHOUSE_CODE" ? (
        <p className="text-sm text-danger">
          {labels.errors[state.error] ?? labels.errors["errors.generic"]}
        </p>
      ) : null}

      <div className="flex gap-2">
        <SubmitButton>{labels.save}</SubmitButton>
        <button
          type="button" onClick={() => router.back()}
          className="rounded-lg border border-line px-4 py-2 text-sm"
        >
          {labels.cancel}
        </button>
      </div>
    </form>
  );
}

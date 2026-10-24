"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createVariantAction } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatQty } from "@/lib/format";
import { fromCost } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export interface VariantRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  attributes: string;
  sellingPrice: number;
  status: string;
  statusLabel: string;
  availableQty: number;
  avgCost: number;
}

interface NewVariantValues {
  name: string; sku: string; barcode: string;
  sellingPrice: string; purchasePrice: string;
  attrs: { name: string; value: string }[];
}

const EMPTY_VARIANT: NewVariantValues = {
  name: "", sku: "", barcode: "", sellingPrice: "", purchasePrice: "",
  attrs: [{ name: "", value: "" }],
};

export function VariantSection({
  productId, locale, currency, canViewCost, canCreate, variants, labels,
}: {
  productId: string;
  locale: Locale;
  currency: string;
  canViewCost: boolean;
  /** `products.create` — createVariantAction is gated on it server-side too; hiding the form for a role without it (e.g. SALES_EMPLOYEE) isn't just cosmetic, it also keeps the cost input (below) from ever rendering for a role that can't view cost either. */
  canCreate: boolean;
  variants: VariantRow[];
  labels: {
    title: string; add: string; name: string; sku: string; barcode: string;
    attributes: string; attributeName: string; attributeValue: string; addAttribute: string;
    avgCost: string; sellingPrice: string; available: string; status: string; error: string;
    empty: string; save: string;
    // The label for the create-variant form's `purchasePrice` INPUT — a
    // distinct string from `avgCost` (the read-only table column showing the
    // computed average). The form used to reuse `avgCost` for both, which
    // reads oddly on an editable price entry (Stage 1B review, minors);
    // `products.purchasePrice` already exists in the catalog for this.
    purchasePrice: string;
    // Same treatment as ProductForm.tsx's identically-named field: a
    // duplicate SKU is a ServiceError (DUPLICATE_SKU), not a Zod validation
    // issue, so it doesn't come back through a `fields` map — surface it
    // next to the SKU input instead of behind the generic banner below.
    duplicateSku: string;
  };
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(
    async (_prev: Awaited<ReturnType<typeof createVariantAction>> | null, formData: FormData) =>
      createVariantAction(formData),
    null,
  );

  // Controlled fields, deliberately — see the identical note in
  // ProductForm.tsx: React resets a <form>'s uncontrolled fields to their
  // defaults after ANY dispatched action settles, success or failure, which
  // would otherwise wipe a merchant's half-typed variant on a duplicate-SKU
  // rejection. `values` only resets to EMPTY_VARIANT on a confirmed success
  // (below), not as a side effect of the browser's own form-reset behavior.
  const [values, setValues] = useState<NewVariantValues>(EMPTY_VARIANT);

  // Adjust state in response to `state` changing, during render rather than
  // in an effect (react-hooks/set-state-in-effect). Unlike ProductForm, this
  // component stays on the same page after a successful submit (it just
  // refreshes the variant list below the mini-form), so its own fields have
  // to reset themselves back to EMPTY_VARIANT here — ProductForm has no
  // equivalent of this pattern because on success it navigates away instead
  // of resetting its own fields, so a plain `useEffect` is enough for it.
  // router.refresh() (a genuine external-system call, not setState) stays in
  // the effect below.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setValues(EMPTY_VARIANT);
  }

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  function setField<K extends keyof NewVariantValues>(key: K, value: NewVariantValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }
  function setAttr(index: number, field: "name" | "value", value: string) {
    setValues((prev) => ({
      ...prev,
      attrs: prev.attrs.map((a, i) => (i === index ? { ...a, [field]: value } : a)),
    }));
  }

  // Same rule as ProductForm.tsx's skuError: a duplicate variant SKU reads
  // as a field-level error next to the SKU input, not the generic message —
  // previously this form showed `labels.error` for every failure, including
  // this one, while the main product form already gave duplicate SKUs their
  // own field-level message for the identical conflict.
  const skuError = state && !state.ok && state.code === "DUPLICATE_SKU"
    ? labels.duplicateSku
    : undefined;

  const columns: Column<VariantRow>[] = [
    { key: "name", header: labels.name, render: (row) => row.name },
    { key: "sku", header: labels.sku, render: (row) => row.sku },
    { key: "barcode", header: labels.barcode, render: (row) => row.barcode ?? "—" },
    {
      key: "attributes", header: labels.attributes,
      render: (row) => {
        const parsed = JSON.parse(row.attributes || "{}") as Record<string, string>;
        const pairs = Object.entries(parsed);
        return pairs.length ? pairs.map(([k, v]) => `${k}: ${v}`).join(", ") : "—";
      },
    },
    ...(canViewCost ? [{
      key: "cost", header: labels.avgCost, align: "end" as const,
      render: (row: VariantRow) => (
        <Money minor={Math.round(fromCost(row.avgCost))} locale={locale} currency={currency} />
      ),
    }] : []),
    {
      key: "price", header: labels.sellingPrice, align: "end",
      render: (row) => <Money minor={row.sellingPrice} locale={locale} currency={currency} />,
    },
    {
      key: "stock", header: labels.available, align: "end",
      render: (row) => formatQty(row.availableQty, locale),
    },
    {
      key: "status", header: labels.status,
      render: (row) => (
        <StatusBadge label={row.statusLabel} tone={row.status === "ACTIVE" ? "success" : "neutral"} />
      ),
    },
  ];

  return (
    <div>
      {variants.length > 0 ? (
        <div className="mb-4">
          <DataTable columns={columns} rows={variants} empty={<p>{labels.empty}</p>} />
        </div>
      ) : null}

      {canCreate ? (
      <form action={formAction} className="rounded-xl border border-line bg-panel p-4">
        <input type="hidden" name="productId" value={productId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label={labels.name} required>
            <input
              type="text" name="name" required className={inputClass}
              value={values.name} onChange={(e) => setField("name", e.target.value)}
            />
          </FormField>
          <FormField label={labels.sku} required error={skuError}>
            <input
              type="text" name="sku" required className={inputClass}
              value={values.sku} onChange={(e) => setField("sku", e.target.value)}
            />
          </FormField>
          <FormField label={labels.barcode}>
            <input
              type="text" name="barcode" className={inputClass}
              value={values.barcode} onChange={(e) => setField("barcode", e.target.value)}
            />
          </FormField>
          <FormField label={labels.sellingPrice}>
            <input
              type="number" name="sellingPrice" min={0} step="0.01" className={inputClass}
              value={values.sellingPrice} onChange={(e) => setField("sellingPrice", e.target.value)}
            />
          </FormField>
          {canViewCost ? (
            <FormField label={labels.purchasePrice}>
              <input
                type="number" name="purchasePrice" min={0} step="0.01" className={inputClass}
                value={values.purchasePrice} onChange={(e) => setField("purchasePrice", e.target.value)}
              />
            </FormField>
          ) : null}
        </div>

        <div className="mt-3 space-y-2">
          <span className="block text-sm font-medium">{labels.attributes}</span>
          {values.attrs.map((attr, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text" name="attrName" placeholder={labels.attributeName} className={inputClass}
                value={attr.name} onChange={(e) => setAttr(i, "name", e.target.value)}
              />
              <input
                type="text" name="attrValue" placeholder={labels.attributeValue} className={inputClass}
                value={attr.value} onChange={(e) => setAttr(i, "value", e.target.value)}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setValues((prev) => ({ ...prev, attrs: [...prev.attrs, { name: "", value: "" }] }))}
            className="rounded-lg border border-line px-3 py-1 text-xs text-brand"
          >
            {labels.addAttribute}
          </button>
        </div>

        {state && !state.ok && state.code !== "DUPLICATE_SKU" ? (
          <p className="mt-2 text-sm text-danger">{labels.error}</p>
        ) : null}

        <div className="mt-3">
          <SubmitButton>{labels.save}</SubmitButton>
        </div>
      </form>
      ) : null}
    </div>
  );
}

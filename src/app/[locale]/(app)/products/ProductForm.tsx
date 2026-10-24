"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createProductAction, updateProductAction, createCategoryAction, createBrandAction,
} from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { Locale } from "@/lib/i18n";

export interface CategoryOption { id: string; nameAr: string; nameEn: string }
export interface BrandOption { id: string; name: string }
export interface WarehouseOption { id: string; name: string }

export interface ProductFormLabels {
  sectionBasicInfo: string; sectionPricing: string; sectionInventory: string;
  sectionPhysicalDetails: string;
  nameAr: string; nameEn: string; sku: string; barcode: string; category: string; brand: string;
  descriptionAr: string; descriptionEn: string;
  purchasePrice: string; sellingPrice: string; wholesalePrice: string; minSellingPrice: string;
  taxRate: string;
  reorderLevel: string; reorderQty: string; trackInventory: string; allowBackorder: string;
  openingQty: string; openingWarehouse: string;
  weight: string; length: string; width: string; height: string;
  save: string; cancel: string; none: string;
  duplicateSku: string;
  addCategory: string; addBrand: string;
  categoryNameAr: string; categoryNameEn: string; brandName: string;
  // Keyed by the translation key an action returns in `error`/`code` (e.g.
  // "errors.DUPLICATE_CATEGORY"), pre-translated server-side — same pattern
  // as RegisterForm.tsx. Both the category/brand quick-add errors and the
  // main form's own action errors resolve through this map, with
  // "errors.generic" as the fallback for any code not explicitly listed, so
  // neither ever renders a raw, untranslated key to the user.
  errors: Record<string, string>;
}

interface FormValues {
  nameAr: string; nameEn: string; sku: string; barcode: string;
  descriptionAr: string; descriptionEn: string;
  purchasePrice: string; sellingPrice: string; wholesalePrice: string; minSellingPrice: string;
  taxRate: string;
  reorderLevel: string; reorderQty: string;
  trackInventory: boolean; allowBackorder: boolean;
  openingQty: string; openingWarehouseId: string;
  weightGrams: string; lengthMm: string; widthMm: string; heightMm: string;
}

// A decimal field's string form for a minor-unit price/qty value: `0`
// renders as an empty field (Stage 1 treats "not set" and "zero" the same
// way on this form), anything else renders with 2dp for money-scaled values.
function moneyString(minor: number, decimals = 2): string {
  return minor ? (minor / 10 ** decimals).toString() : "";
}
function qtyString(scaled: number): string {
  return scaled ? (scaled / 1000).toString() : "";
}
function intString(value: number): string {
  return value ? value.toString() : "";
}

export function ProductForm({
  locale, mode, productId, defaults, categories: initialCategories, brands: initialBrands,
  warehouses, labels,
}: {
  locale: Locale;
  mode: "create" | "edit";
  productId?: string;
  defaults: {
    nameAr: string; nameEn: string; sku: string; barcode: string;
    categoryId: string; brandId: string;
    descriptionAr: string; descriptionEn: string;
    purchasePrice: number; sellingPrice: number; wholesalePrice: number; minSellingPrice: number;
    taxRatePct: number;
    weightGrams: number; lengthMm: number; widthMm: number; heightMm: number;
    reorderLevel: number; reorderQty: number;
    trackInventory: boolean; allowBackorder: boolean;
  };
  categories: CategoryOption[];
  brands: BrandOption[];
  warehouses: WarehouseOption[];
  labels: ProductFormLabels;
}) {
  const router = useRouter();
  const rawAction = mode === "create" ? createProductAction : updateProductAction;
  const [state, formAction] = useActionState(
    async (_prev: Awaited<ReturnType<typeof rawAction>> | null, formData: FormData) =>
      rawAction(formData),
    null,
  );

  useEffect(() => {
    if (state?.ok) router.push(`/${locale}/products/${state.data.id}`);
  }, [state, router, locale]);

  const [categories, setCategories] = useState(initialCategories);
  const [brands, setBrands] = useState(initialBrands);
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingBrand, setAddingBrand] = useState(false);
  const [newCategoryAr, setNewCategoryAr] = useState("");
  const [newCategoryEn, setNewCategoryEn] = useState("");
  const [newBrandName, setNewBrandName] = useState("");
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Every field is a controlled input backed by this one state object,
  // deliberately — NOT `defaultValue`. React resets a `<form>`'s uncontrolled
  // fields back to their `defaultValue`/`defaultChecked` after ANY action
  // dispatched via its `action` prop settles, success or failure (this is
  // documented React 19 form-action behavior, not a bug in this app). Left
  // uncontrolled, a duplicate-SKU rejection would wipe every other field the
  // merchant had already typed, forcing them to re-enter the whole product
  // just to fix one field. Controlled inputs are React's own documented way
  // to opt out of that auto-reset.
  const [values, setValues] = useState<FormValues>({
    nameAr: defaults.nameAr, nameEn: defaults.nameEn, sku: defaults.sku, barcode: defaults.barcode,
    descriptionAr: defaults.descriptionAr, descriptionEn: defaults.descriptionEn,
    purchasePrice: moneyString(defaults.purchasePrice), sellingPrice: moneyString(defaults.sellingPrice),
    wholesalePrice: moneyString(defaults.wholesalePrice), minSellingPrice: moneyString(defaults.minSellingPrice),
    taxRate: moneyString(defaults.taxRatePct),
    reorderLevel: qtyString(defaults.reorderLevel), reorderQty: qtyString(defaults.reorderQty),
    trackInventory: defaults.trackInventory, allowBackorder: defaults.allowBackorder,
    openingQty: "", openingWarehouseId: "",
    weightGrams: intString(defaults.weightGrams), lengthMm: intString(defaults.lengthMm),
    widthMm: intString(defaults.widthMm), heightMm: intString(defaults.heightMm),
  });
  const [categoryId, setCategoryId] = useState(defaults.categoryId);
  const [brandId, setBrandId] = useState(defaults.brandId);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function addCategory() {
    const fd = new FormData();
    fd.set("nameAr", newCategoryAr);
    fd.set("nameEn", newCategoryEn);
    const result = await createCategoryAction(fd);
    if (result.ok) {
      setCategories((prev) => [...prev, { id: result.data.id, nameAr: newCategoryAr, nameEn: newCategoryEn }]);
      setCategoryId(result.data.id);
      setAddingCategory(false);
      setNewCategoryAr("");
      setNewCategoryEn("");
      setCatalogError(null);
    } else {
      setCatalogError(result.error);
    }
  }

  async function addBrand() {
    const fd = new FormData();
    fd.set("name", newBrandName);
    const result = await createBrandAction(fd);
    if (result.ok) {
      setBrands((prev) => [...prev, { id: result.data.id, name: newBrandName }]);
      setBrandId(result.data.id);
      setAddingBrand(false);
      setNewBrandName("");
      setCatalogError(null);
    } else {
      setCatalogError(result.error);
    }
  }

  // DUPLICATE_SKU is a `ServiceError` thrown by createProduct/updateProduct
  // (a same-company clash), not a Zod validation issue — action()'s `fields`
  // map is only populated on schema-parse failures. Surface it on the SKU
  // input specifically, per the requirement that a duplicate SKU reads as a
  // field-level error rather than the generic banner below.
  const skuError = state && !state.ok && state.code === "DUPLICATE_SKU"
    ? labels.duplicateSku
    : undefined;

  // A VALIDATION failure (a bad numeric value, a required field missing on a
  // direct POST that bypasses the browser's own checks, the opening-stock
  // business-rule checks in actions.ts) populates `state.fields` — one raw
  // Zod issue message per field path — but nothing rendered them, so a
  // schema rejection used to be a silent no-op: the form just sat there with
  // no visible change. Surface each one next to its own input, same
  // placement as skuError above.
  //
  // A field's raw message may itself be a dictionary key (e.g.
  // "errors.OPENING_PRICE_REQUIRED", from actions.ts's superRefine) rather
  // than display text, exactly like `state.error`/`catalogError` below — so
  // it gets the identical `labels.errors` lookup before it ever reaches the
  // screen, instead of a raw key rendering verbatim to an Arabic merchant.
  // A message that isn't a dictionary key (e.g. a built-in Zod message) has
  // no entry in `labels.errors` and falls back to itself unchanged.
  const fieldErrors = state && !state.ok ? state.fields : undefined;
  function fieldError(name: string): string | undefined {
    const raw = fieldErrors?.[name];
    if (raw === undefined) return undefined;
    return labels.errors[raw] ?? raw;
  }

  return (
    <form action={formAction} className="max-w-3xl space-y-10">
      {mode === "edit" ? <input type="hidden" name="id" value={productId} /> : null}

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.sectionBasicInfo}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={labels.nameAr} required error={fieldError("nameAr")}>
            <input
              type="text" name="nameAr" dir="rtl" required
              value={values.nameAr} onChange={(e) => set("nameAr", e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label={labels.nameEn} required error={fieldError("nameEn")}>
            <input
              type="text" name="nameEn" required
              value={values.nameEn} onChange={(e) => set("nameEn", e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label={labels.sku} required error={skuError ?? fieldError("sku")}>
            <input
              type="text" name="sku" required
              value={values.sku} onChange={(e) => set("sku", e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label={labels.barcode} error={fieldError("barcode")}>
            <input
              type="text" name="barcode"
              value={values.barcode} onChange={(e) => set("barcode", e.target.value)}
              className={inputClass}
            />
          </FormField>

          <FormField label={labels.category} error={fieldError("categoryId")}>
            <div className="flex gap-2">
              <select
                name="categoryId" className={inputClass}
                value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">{labels.none}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{locale === "ar" ? c.nameAr : c.nameEn}</option>
                ))}
              </select>
              <button
                type="button" onClick={() => setAddingCategory((v) => !v)}
                className="shrink-0 rounded-lg border border-line px-3 text-sm text-brand"
                aria-label={labels.addCategory}
              >
                +
              </button>
            </div>
            {addingCategory ? (
              <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-3">
                <input
                  type="text" placeholder={labels.categoryNameAr} dir="rtl"
                  value={newCategoryAr} onChange={(e) => setNewCategoryAr(e.target.value)}
                  className={inputClass}
                />
                <input
                  type="text" placeholder={labels.categoryNameEn}
                  value={newCategoryEn} onChange={(e) => setNewCategoryEn(e.target.value)}
                  className={inputClass}
                />
                <button
                  type="button" onClick={addCategory}
                  disabled={!newCategoryAr.trim() || !newCategoryEn.trim()}
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink disabled:opacity-60"
                >
                  {labels.addCategory}
                </button>
              </div>
            ) : null}
          </FormField>

          <FormField label={labels.brand} error={fieldError("brandId")}>
            <div className="flex gap-2">
              <select
                name="brandId" className={inputClass}
                value={brandId} onChange={(e) => setBrandId(e.target.value)}
              >
                <option value="">{labels.none}</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button
                type="button" onClick={() => setAddingBrand((v) => !v)}
                className="shrink-0 rounded-lg border border-line px-3 text-sm text-brand"
                aria-label={labels.addBrand}
              >
                +
              </button>
            </div>
            {addingBrand ? (
              <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-3">
                <input
                  type="text" placeholder={labels.brandName}
                  value={newBrandName} onChange={(e) => setNewBrandName(e.target.value)}
                  className={inputClass}
                />
                <button
                  type="button" onClick={addBrand}
                  disabled={!newBrandName.trim()}
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink disabled:opacity-60"
                >
                  {labels.addBrand}
                </button>
              </div>
            ) : null}
          </FormField>
        </div>
        {catalogError ? (
          <p className="text-sm text-danger">
            {labels.errors[catalogError] ?? labels.errors["errors.generic"]}
          </p>
        ) : null}

        <FormField label={labels.descriptionAr} error={fieldError("descriptionAr")}>
          <textarea
            name="descriptionAr" dir="rtl" rows={2} className={inputClass}
            value={values.descriptionAr} onChange={(e) => set("descriptionAr", e.target.value)}
          />
        </FormField>
        <FormField label={labels.descriptionEn} error={fieldError("descriptionEn")}>
          <textarea
            name="descriptionEn" rows={2} className={inputClass}
            value={values.descriptionEn} onChange={(e) => set("descriptionEn", e.target.value)}
          />
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.sectionPricing}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={labels.purchasePrice} error={fieldError("purchasePrice")}>
            <input
              type="number" name="purchasePrice" min={0} step="0.01" className={inputClass}
              value={values.purchasePrice} onChange={(e) => set("purchasePrice", e.target.value)}
            />
          </FormField>
          <FormField label={labels.sellingPrice} error={fieldError("sellingPrice")}>
            <input
              type="number" name="sellingPrice" min={0} step="0.01" className={inputClass}
              value={values.sellingPrice} onChange={(e) => set("sellingPrice", e.target.value)}
            />
          </FormField>
          <FormField label={labels.wholesalePrice} error={fieldError("wholesalePrice")}>
            <input
              type="number" name="wholesalePrice" min={0} step="0.01" className={inputClass}
              value={values.wholesalePrice} onChange={(e) => set("wholesalePrice", e.target.value)}
            />
          </FormField>
          <FormField label={labels.minSellingPrice} error={fieldError("minSellingPrice")}>
            <input
              type="number" name="minSellingPrice" min={0} step="0.01" className={inputClass}
              value={values.minSellingPrice} onChange={(e) => set("minSellingPrice", e.target.value)}
            />
          </FormField>
          <FormField label={labels.taxRate} error={fieldError("taxRate")}>
            <input
              type="number" name="taxRate" min={0} max={100} step="0.01" className={inputClass}
              value={values.taxRate} onChange={(e) => set("taxRate", e.target.value)}
            />
          </FormField>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.sectionInventory}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={labels.reorderLevel} error={fieldError("reorderLevel")}>
            <input
              type="number" name="reorderLevel" min={0} step="0.001" className={inputClass}
              value={values.reorderLevel} onChange={(e) => set("reorderLevel", e.target.value)}
            />
          </FormField>
          <FormField label={labels.reorderQty} error={fieldError("reorderQty")}>
            <input
              type="number" name="reorderQty" min={0} step="0.001" className={inputClass}
              value={values.reorderQty} onChange={(e) => set("reorderQty", e.target.value)}
            />
          </FormField>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox" name="trackInventory"
            checked={values.trackInventory} onChange={(e) => set("trackInventory", e.target.checked)}
          />
          {labels.trackInventory}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox" name="allowBackorder"
            checked={values.allowBackorder} onChange={(e) => set("allowBackorder", e.target.checked)}
          />
          {labels.allowBackorder}
        </label>

        {mode === "create" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label={labels.openingQty} error={fieldError("openingQty")}>
              <input
                type="number" name="openingQty" min={0} step="0.001" className={inputClass}
                value={values.openingQty} onChange={(e) => set("openingQty", e.target.value)}
              />
            </FormField>
            <FormField label={labels.openingWarehouse} error={fieldError("openingWarehouseId")}>
              <select
                name="openingWarehouseId" className={inputClass}
                value={values.openingWarehouseId} onChange={(e) => set("openingWarehouseId", e.target.value)}
              >
                <option value="">{labels.none}</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </FormField>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.sectionPhysicalDetails}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <FormField label={labels.weight} error={fieldError("weightGrams")}>
            <input
              type="number" name="weightGrams" min={0} step="1" className={inputClass}
              value={values.weightGrams} onChange={(e) => set("weightGrams", e.target.value)}
            />
          </FormField>
          <FormField label={labels.length} error={fieldError("lengthMm")}>
            <input
              type="number" name="lengthMm" min={0} step="1" className={inputClass}
              value={values.lengthMm} onChange={(e) => set("lengthMm", e.target.value)}
            />
          </FormField>
          <FormField label={labels.width} error={fieldError("widthMm")}>
            <input
              type="number" name="widthMm" min={0} step="1" className={inputClass}
              value={values.widthMm} onChange={(e) => set("widthMm", e.target.value)}
            />
          </FormField>
          <FormField label={labels.height} error={fieldError("heightMm")}>
            <input
              type="number" name="heightMm" min={0} step="1" className={inputClass}
              value={values.heightMm} onChange={(e) => set("heightMm", e.target.value)}
            />
          </FormField>
        </div>
      </fieldset>

      {state && !state.ok && state.code !== "VALIDATION" && state.code !== "DUPLICATE_SKU" ? (
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

"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPurchaseOrderAction } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Money } from "@/components/ui/Money";
import { toQty, toMinor, fromMinor, fromCost, applyPct, QTY_SCALE } from "@/lib/money";
import { allocateCost, landedUnitCost, type AllocationLine } from "@/services/costing";
import type { AllocationMethod, PurchaseCostType } from "@/lib/constants";
import type { Locale } from "@/lib/i18n";

interface Line {
  key: string;
  productId: string;
  quantity: string;
  unitCost: string;
  discount: string;
  taxRatePct: string;
}

interface CostLine {
  key: string;
  costType: PurchaseCostType | "";
  description: string;
  amount: string;
}

let counter = 0;
function newLine(defaultTaxRatePct: string): Line {
  counter += 1;
  return { key: `line-${counter}`, productId: "", quantity: "", unitCost: "", discount: "0", taxRatePct: defaultTaxRatePct };
}
function newCostLine(): CostLine {
  counter += 1;
  return { key: `cost-${counter}`, costType: "", description: "", amount: "" };
}

export interface PurchaseOrderFormLabels {
  supplier: string; warehouse: string; orderDate: string; expectedDate: string;
  allocationMethod: string; notes: string;
  product: string; quantity: string; unitPrice: string; discount: string; tax: string; lineTotal: string;
  addLine: string; removeLine: string;
  costType: string; costDescription: string; costAmount: string; addCost: string; removeCost: string;
  summary: string; subtotal: string; discountTotal: string; taxTotal: string; additionalCostTotal: string;
  grandTotal: string; projectedLandedCost: string; landedCostHint: string;
  allocationOptions: Record<AllocationMethod, string>;
  costTypeOptions: Record<PurchaseCostType, string>;
  save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessageTemplate: string;
  errors: Record<string, string>;
}

const ALLOCATION_CHOICES: AllocationMethod[] = ["QUANTITY", "VALUE", "WEIGHT", "EQUAL"];

export function PurchaseOrderForm({
  locale, currency, suppliers, warehouses, products, defaultTaxRatePct, labels,
}: {
  locale: Locale;
  currency: string;
  suppliers: { id: string; name: string }[];
  warehouses: { id: string; name: string }[];
  products: { id: string; nameAr: string; nameEn: string; weightGrams: number; purchasePrice: number }[];
  /** Company.defaultTaxRatePct in basis points (e.g. 1500 = 15%), used only to prefill new lines. */
  defaultTaxRatePct: number;
  labels: PurchaseOrderFormLabels;
}) {
  const router = useRouter();
  const defaultTaxPctText = defaultTaxRatePct > 0 ? String(defaultTaxRatePct / 100) : "0";

  const [supplierId, setSupplierId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [allocationMethod, setAllocationMethod] = useState<AllocationMethod>("VALUE");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine(defaultTaxPctText)]);
  const [costs, setCosts] = useState<CostLine[]>([]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof createPurchaseOrderAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — two confirms fired
  // synchronously in the same tick both read the same stale, pre-update
  // `submitting` closure value, so a state-only check does not block the
  // second one. Same pattern as every other Task 6 mutation form.
  const submittingRef = useRef(false);

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function setLine<K extends keyof Line>(key: string, field: K, value: Line[K]) {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const next = { ...l, [field]: value };
      // Prefill the unit cost from the product's own purchase price the
      // moment it's picked, but only while the field is still untouched —
      // never overwrite a cost the merchant already typed.
      if (field === "productId" && l.unitCost.trim() === "") {
        const product = productMap.get(value as string);
        if (product && product.purchasePrice > 0) {
          next.unitCost = String(fromMinor(product.purchasePrice));
        }
      }
      return next;
    }));
  }
  function setCost<K extends keyof CostLine>(key: string, field: K, value: CostLine[K]) {
    setCosts((prev) => prev.map((c) => (c.key === key ? { ...c, [field]: value } : c)));
  }

  // Every figure below is derived in the exact same SCALED-integer domain
  // the server (createPurchaseOrder in src/services/purchases.ts) computes
  // in — toQty/toMinor/applyPct, never raw floats — so this preview agrees
  // with the posted totals to the minor unit, not just approximately.
  const computed = useMemo(() => lines.map((line) => {
    const qty = line.quantity.trim() !== "" ? toQty(line.quantity) : 0;
    const unitPrice = line.unitCost.trim() !== "" ? toMinor(line.unitCost) : 0;
    const gross = Math.round((qty * unitPrice) / QTY_SCALE);
    const discountAmount = line.discount.trim() !== "" ? toMinor(line.discount) : 0;
    const valid = !!line.productId && qty > 0;
    // NOT clamped to `gross` — createPurchaseOrder rejects discountAmount >
    // gross outright with INVALID_DISCOUNT (src/services/purchases.ts); a
    // clamped preview would show an optimistic SAR 0.00 line total for input
    // the server would actually refuse. discountExceedsGross below drives a
    // field-level error and blocks submission instead.
    //
    // Gated on `valid`, not computed from raw discountAmount/gross alone: an
    // incomplete line (no product picked yet, or quantity still blank) has
    // gross === 0, so ANY nonzero discount typed in before the rest of the
    // row is filled in would otherwise trip this — the wrong problem to
    // surface on a row that's simply not finished yet.
    const discountExceedsGross = valid && discountAmount > gross;
    const lineTotal = gross - discountAmount;
    const taxRateBp = line.taxRatePct.trim() !== "" ? Math.round(Number(line.taxRatePct) * 100) : 0;
    const taxAmount = applyPct(lineTotal, taxRateBp);
    const product = productMap.get(line.productId);
    return {
      ...line, qty, unitPrice, gross, discountAmount, discountExceedsGross, lineTotal, taxAmount,
      weightGrams: product?.weightGrams ?? 0,
      valid,
    };
  }), [lines, productMap]);

  // Lines with a valid product+quantity but an invalid discount are excluded
  // from every downstream total AND from allocateCost's inputs (a negative
  // lineValue weight would throw INVALID_ALLOCATION_WEIGHT) — canSubmit below
  // blocks the whole submission while any such line exists, so nothing here
  // is ever silently dropped from what actually posts. (discountExceedsGross
  // is already gated on `valid` above, so checking it alone is enough here.)
  const validComputed = computed.filter((l) => l.valid && !l.discountExceedsGross);
  const hasDiscountError = computed.some((l) => l.discountExceedsGross);
  const subtotal = validComputed.reduce((s, l) => s + l.lineTotal, 0);
  const discountTotal = validComputed.reduce((s, l) => s + l.discountAmount, 0);
  const taxTotal = validComputed.reduce((s, l) => s + l.taxAmount, 0);

  // A blank or zero amount would otherwise post a no-op
  // PurchaseAdditionalCost row (costType set, amount 0) — require a positive
  // amount before a cost row counts toward anything, preview or submission.
  const validCosts = costs.filter((c) => c.costType && Number(c.amount || 0) > 0);
  const additionalCostTotal = validCosts.reduce((s, c) => s + toMinor(c.amount), 0);
  const grandTotal = subtotal + taxTotal + additionalCostTotal;

  // The SAME allocateCost/landedUnitCost functions createPurchaseOrder's
  // sibling receivePurchase posts with (src/services/costing.ts) — this
  // preview is only exact for a single FULL receipt (see landedCostHint
  // below): a partial receipt allocates pro-rata per receipt, and WEIGHT
  // re-reads the product's CURRENT weight at receive time, not this value.
  const allocationLines: AllocationLine[] = validComputed.map((l) => ({
    quantity: l.qty, lineValue: l.lineTotal, weightGrams: l.weightGrams,
  }));
  const allocations = allocationLines.length > 0
    ? allocateCost(additionalCostTotal, allocationMethod, allocationLines)
    : [];
  const landedCosts = validComputed.map((l, i) => landedUnitCost(l.lineTotal, allocations[i] ?? 0, l.qty));

  const canSubmit = !!supplierId && !!warehouseId && validComputed.length > 0 && !hasDiscountError;

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("supplierId", supplierId);
    fd.set("warehouseId", warehouseId);
    if (orderDate) fd.set("orderDate", orderDate);
    if (expectedDate) fd.set("expectedDate", expectedDate);
    fd.set("allocationMethod", allocationMethod);
    fd.set("notes", notes);
    fd.set("linesJson", JSON.stringify(validComputed.map((l) => ({
      productId: l.productId,
      orderedQty: Number(l.quantity),
      unitPrice: Number(l.unitCost || 0),
      discountAmount: Number(l.discount || 0),
      taxRatePct: Number(l.taxRatePct || 0),
    }))));
    fd.set("additionalCostsJson", JSON.stringify(validCosts.map((c) => ({
      costType: c.costType,
      description: c.description || undefined,
      amount: Number(c.amount || 0),
    }))));
    try {
      const res = await createPurchaseOrderAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/purchases/${res.data.purchaseOrderId}`);
    } catch (error) {
      console.error("Create purchase order request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const fieldErrors = result && !result.ok ? result.fields : undefined;
  const linesError = fieldErrors?.linesJson;
  const linesErrorMessage = linesError ? (labels.errors[linesError] ?? linesError) : undefined;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label={labels.supplier} required>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </FormField>
        <FormField label={labels.warehouse} required>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </FormField>
        <FormField label={labels.orderDate}>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.expectedDate}>
          <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.allocationMethod} required>
          <select
            value={allocationMethod}
            onChange={(e) => setAllocationMethod(e.target.value as AllocationMethod)}
            className={inputClass}
          >
            {ALLOCATION_CHOICES.map((m) => (
              <option key={m} value={m}>{labels.allocationOptions[m]}</option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{labels.product}</h2>
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface">
              <tr>
                <th className="px-3 py-2 text-start font-medium text-muted">{labels.product}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.quantity}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.unitPrice}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.discount}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.tax}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.lineTotal}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.projectedLandedCost}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {computed.map((line, i) => (
                <tr key={line.key} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <select
                      value={line.productId}
                      onChange={(e) => setLine(line.key, "productId", e.target.value)}
                      className={inputClass}
                    >
                      <option value="">—</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{locale === "ar" ? p.nameAr : p.nameEn}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} step="0.001" value={line.quantity}
                      onChange={(e) => setLine(line.key, "quantity", e.target.value)}
                      className={`${inputClass} w-24 text-end`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} step="0.01" value={line.unitCost}
                      onChange={(e) => setLine(line.key, "unitCost", e.target.value)}
                      className={`${inputClass} w-28 text-end`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} step="0.01" value={line.discount}
                      onChange={(e) => setLine(line.key, "discount", e.target.value)}
                      className={`${inputClass} w-24 text-end ${line.discountExceedsGross ? "border-danger" : ""}`}
                    />
                    {line.discountExceedsGross ? (
                      <span className="mt-1 block text-xs text-danger">{labels.errors["errors.INVALID_DISCOUNT"]}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} max={100} step="0.01" value={line.taxRatePct}
                      onChange={(e) => setLine(line.key, "taxRatePct", e.target.value)}
                      className={`${inputClass} w-20 text-end`}
                    />
                  </td>
                  <td className="px-3 py-2 text-end font-medium">
                    <Money minor={line.lineTotal} locale={locale} currency={currency} />
                  </td>
                  <td className="px-3 py-2 text-end text-muted">
                    {line.valid && !line.discountExceedsGross ? (
                      <Money
                        minor={Math.round(fromCost(landedCosts[validComputed.findIndex((l) => l.key === line.key)] ?? 0))}
                        locale={locale} currency={currency}
                      />
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== line.key) : prev))}
                      disabled={lines.length <= 1}
                      className="rounded-lg border border-line px-2 py-1 text-xs text-danger disabled:opacity-40"
                    >
                      {labels.removeLine}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, newLine(defaultTaxPctText)])}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-brand"
        >
          {labels.addLine}
        </button>
        {linesErrorMessage ? <p className="text-sm text-danger">{linesErrorMessage}</p> : null}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{labels.additionalCostTotal}</h2>
        {costs.map((cost) => (
          <div key={cost.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-3">
            <div className="w-48">
              <FormField label={labels.costType}>
                <select
                  value={cost.costType}
                  onChange={(e) => setCost(cost.key, "costType", e.target.value as PurchaseCostType)}
                  className={inputClass}
                >
                  <option value="">—</option>
                  {(Object.keys(labels.costTypeOptions) as PurchaseCostType[]).map((ct) => (
                    <option key={ct} value={ct}>{labels.costTypeOptions[ct]}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <div className="flex-1">
              <FormField label={labels.costDescription}>
                <input
                  type="text" value={cost.description}
                  onChange={(e) => setCost(cost.key, "description", e.target.value)}
                  className={inputClass}
                />
              </FormField>
            </div>
            <div className="w-32">
              <FormField label={labels.costAmount}>
                <input
                  type="number" min={0} step="0.01" value={cost.amount}
                  onChange={(e) => setCost(cost.key, "amount", e.target.value)}
                  className={inputClass}
                />
              </FormField>
            </div>
            <button
              type="button"
              onClick={() => setCosts((prev) => prev.filter((c) => c.key !== cost.key))}
              className="mb-1 shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-danger"
            >
              {labels.removeCost}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setCosts((prev) => [...prev, newCostLine()])}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-brand"
        >
          {labels.addCost}
        </button>
      </div>

      <FormField label={labels.notes}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </FormField>

      <div className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{labels.summary}</h2>
        <dl className="grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-muted">{labels.subtotal}</dt>
          <dd className="text-end"><Money minor={subtotal} locale={locale} currency={currency} /></dd>
          <dt className="text-muted">{labels.discountTotal}</dt>
          <dd className="text-end"><Money minor={discountTotal} locale={locale} currency={currency} /></dd>
          <dt className="text-muted">{labels.taxTotal}</dt>
          <dd className="text-end"><Money minor={taxTotal} locale={locale} currency={currency} /></dd>
          <dt className="text-muted">{labels.additionalCostTotal}</dt>
          <dd className="text-end"><Money minor={additionalCostTotal} locale={locale} currency={currency} /></dd>
        </dl>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="font-semibold">{labels.grandTotal}</span>
          <span className="text-lg font-semibold">
            <Money minor={grandTotal} locale={locale} currency={currency} />
          </span>
        </div>
        <p className="mt-3 text-xs text-muted">{labels.landedCostHint}</p>
      </div>

      {result && !result.ok && !linesErrorMessage ? (
        <p className="text-sm text-danger">
          {labels.errors[result.error] ?? labels.errors["errors.generic"]}
        </p>
      ) : null}

      <div className="flex gap-2">
        {canSubmit ? (
          <ConfirmDialog
            triggerLabel={submitting ? labels.loading : labels.save}
            title={labels.confirmTitle}
            message={labels.confirmMessageTemplate}
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

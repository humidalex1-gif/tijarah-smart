"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSalesOrderAction } from "../actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Money } from "@/components/ui/Money";
import { fillTemplate } from "@/lib/i18n";
import { formatQty, formatPct } from "@/lib/format";
import { toQty, toMinor, fromMinor, applyPct, costOf, QTY_SCALE } from "@/lib/money";
import type { OrderCostType, SalesChannel } from "@/lib/constants";
import type { Locale } from "@/lib/i18n";

interface Line {
  key: string;
  productId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRatePct: string;
}

interface CostLine {
  key: string;
  costType: OrderCostType | "";
  description: string;
  amount: string;
}

let counter = 0;
function newLine(defaultTaxRatePct: string): Line {
  counter += 1;
  return { key: `line-${counter}`, productId: "", quantity: "", unitPrice: "", discount: "0", taxRatePct: defaultTaxRatePct };
}
function newCostLine(): CostLine {
  counter += 1;
  return { key: `cost-${counter}`, costType: "", description: "", amount: "" };
}

export interface SaleFormLabels {
  customer: string; customerSearchPlaceholder: string; walkIn: string;
  warehouse: string; channel: string; channelOptions: Record<SalesChannel, string>;
  orderDate: string; notes: string;
  product: string; quantity: string; unitPrice: string; discount: string; tax: string; lineTotal: string;
  availableStock: string; stockWarningTemplate: string;
  addLine: string; removeLine: string;
  orderCosts: string; costType: string; costDescription: string; costAmount: string;
  addCost: string; removeCost: string; costTypeOptions: Record<OrderCostType, string>;
  shippingCharged: string; paidAmount: string; account: string; recordPayment: string;
  summary: string; subtotal: string; discountTotal: string; taxTotal: string;
  revenue: string; productCost: string; grossProfit: string; orderCostsTotal: string;
  netProfit: string; margin: string; grandTotal: string;
  save: string; cancel: string; confirm: string; loading: string;
  confirmTitle: string; confirmMessage: string;
  errors: Record<string, string>;
}

const COST_TYPE_CHOICES: OrderCostType[] = ["SHIPPING", "PLATFORM_FEE", "PAYMENT_FEE", "COMMISSION", "OTHER"];

function CustomerPicker({
  customers, value, onChangeAction, placeholder, walkInLabel,
}: {
  customers: { id: string; name: string; phone: string | null }[];
  value: string;
  onChangeAction: (id: string) => void;
  placeholder: string;
  walkInLabel: string;
}) {
  const selected = customers.find((c) => c.id === value);
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);

  const filtered = query.trim() === ""
    ? customers.slice(0, 20)
    : customers.filter((c) => (
      c.name.toLowerCase().includes(query.toLowerCase()) || (c.phone ?? "").includes(query)
    )).slice(0, 20);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); if (value) onChangeAction(""); }}
        // A slight delay so a click on an option below fires before blur
        // closes the dropdown.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={inputClass}
      />
      {value === "" ? <span className="mt-1 block text-xs text-muted">{walkInLabel}</span> : null}
      {open && filtered.length > 0 ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-panel shadow-lg">
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChangeAction(c.id); setQuery(c.name); setOpen(false); }}
                className="block w-full px-3 py-2 text-start text-sm hover:bg-surface"
              >
                {c.name}{c.phone ? <span className="ms-2 text-xs text-muted">{c.phone}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SaleForm({
  locale, currency, customers, warehouses, products, stockByWarehouse, costByWarehouse,
  accounts, canPay, defaultTaxRatePct, defaultWarehouseId, labels,
}: {
  locale: Locale;
  currency: string;
  customers: { id: string; name: string; phone: string | null }[];
  warehouses: { id: string; name: string }[];
  products: { id: string; nameAr: string; nameEn: string; sellingPrice: number }[];
  /** availableQty by warehouseId then productId — unit counts, never gated. */
  stockByWarehouse: Record<string, Record<string, number>>;
  /** COST_SCALE avgCost by warehouseId then productId — undefined entirely for a role without finance.view_profit, never merely hidden. */
  costByWarehouse?: Record<string, Record<string, number>>;
  accounts: { id: string; name: string }[];
  canPay: boolean;
  defaultTaxRatePct: number;
  defaultWarehouseId: string;
  labels: SaleFormLabels;
}) {
  const router = useRouter();
  const defaultTaxPctText = defaultTaxRatePct > 0 ? String(defaultTaxRatePct / 100) : "0";
  const canViewProfit = costByWarehouse !== undefined;

  const [customerId, setCustomerId] = useState("");
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId);
  const [channel, setChannel] = useState<SalesChannel>("STORE");
  const [orderDate, setOrderDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine(defaultTaxPctText)]);
  const [costs, setCosts] = useState<CostLine[]>([]);
  const [shippingCharged, setShippingCharged] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [result, setResult] = useState<Awaited<ReturnType<typeof createSalesOrderAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` STATE below — two confirms fired
  // synchronously in the same tick both read the same stale, pre-update
  // `submitting` closure value. Same pattern as every other Task 6/7 form.
  const submittingRef = useRef(false);

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Memoized (not a bare `?? {}` fallback) so `computed`'s own useMemo below
  // — which depends on these — doesn't see a fresh object identity on every
  // render for a warehouse this map has no entry for.
  const stockForWarehouse = useMemo(
    () => stockByWarehouse[warehouseId] ?? {}, [stockByWarehouse, warehouseId],
  );
  const costForWarehouse = useMemo(
    () => costByWarehouse?.[warehouseId] ?? {}, [costByWarehouse, warehouseId],
  );

  function setLine<K extends keyof Line>(key: string, field: K, value: Line[K]) {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const next = { ...l, [field]: value };
      // Prefill the unit price from the product's own selling price the
      // moment it's picked, but only while the field is still untouched —
      // never overwrite a price the merchant already typed. Same convention
      // as PurchaseOrderForm.tsx's identical prefill.
      if (field === "productId" && l.unitPrice.trim() === "") {
        const product = productMap.get(value as string);
        if (product && product.sellingPrice > 0) {
          next.unitPrice = String(fromMinor(product.sellingPrice));
        }
      }
      return next;
    }));
  }
  function setCost<K extends keyof CostLine>(key: string, field: K, value: CostLine[K]) {
    setCosts((prev) => prev.map((c) => (c.key === key ? { ...c, [field]: value } : c)));
  }

  // Every figure below is derived in the exact same SCALED-integer domain
  // the server (createSalesOrder/confirmSale in src/services/sales.ts)
  // computes in — toQty/toMinor/applyPct/costOf, never raw floats — so this
  // preview agrees with the posted totals to the minor unit, not just
  // approximately.
  const computed = useMemo(() => lines.map((line) => {
    const qty = line.quantity.trim() !== "" ? toQty(line.quantity) : 0;
    // Named unitPriceMinor, NOT unitPrice — `line.unitPrice` (the raw SAR
    // string the <input> is bound to, via `...line` below) would otherwise
    // be silently overwritten by this scaled minor-unit number under the
    // same key, corrupting both the displayed input value and the amount
    // actually submitted. PurchaseOrderForm.tsx sidesteps this collision by
    // naming its raw field `unitCost` instead; this form keeps `unitPrice`
    // as the user-facing name, so the derived value gets the distinct name
    // here instead.
    const unitPriceMinor = line.unitPrice.trim() !== "" ? toMinor(line.unitPrice) : 0;
    const gross = Math.round((qty * unitPriceMinor) / QTY_SCALE);
    const discountAmount = line.discount.trim() !== "" ? toMinor(line.discount) : 0;
    const valid = !!line.productId && qty > 0;
    // NOT clamped to `gross` — createSalesOrder rejects discountAmount >
    // gross outright with INVALID_DISCOUNT, same as createPurchaseOrder.
    const discountExceedsGross = valid && discountAmount > gross;
    const lineTotal = gross - discountAmount;
    const taxRateBp = line.taxRatePct.trim() !== "" ? Math.round(Number(line.taxRatePct) * 100) : 0;
    const taxAmount = applyPct(lineTotal, taxRateBp);
    const available = stockForWarehouse[line.productId] ?? 0;
    // A soft warning only — the create form still lets the merchant submit;
    // confirmSale is the real enforcement and rolls back the whole order if
    // any line is actually short (Task 8 brief).
    const insufficientStock = valid && qty > available;
    const avgCost = costForWarehouse[line.productId] ?? 0;
    const lineCost = valid ? costOf(qty, avgCost) : 0;
    return {
      ...line, qty, gross, discountAmount, discountExceedsGross, lineTotal, taxAmount,
      available, insufficientStock, lineCost, valid,
    };
  }), [lines, stockForWarehouse, costForWarehouse]);

  const validComputed = computed.filter((l) => l.valid && !l.discountExceedsGross);
  const hasDiscountError = computed.some((l) => l.discountExceedsGross);
  const subtotal = validComputed.reduce((s, l) => s + l.lineTotal, 0);
  const discountTotal = validComputed.reduce((s, l) => s + l.discountAmount, 0);
  const taxTotal = validComputed.reduce((s, l) => s + l.taxAmount, 0);
  const productCostTotal = validComputed.reduce((s, l) => s + l.lineCost, 0);
  const grossProfitTotal = subtotal - productCostTotal;

  // A blank or zero amount would otherwise post a no-op SalesOrderCost row —
  // same rule as PurchaseOrderForm.tsx's `validCosts`.
  const validCosts = costs.filter((c) => c.costType && Number(c.amount || 0) > 0);
  const orderCostsTotal = validCosts.reduce((s, c) => s + toMinor(c.amount), 0);
  const shippingChargedMinor = shippingCharged.trim() !== "" ? toMinor(shippingCharged) : 0;
  const grandTotal = subtotal + taxTotal + shippingChargedMinor;

  // Mirrors confirmSale exactly: per-line net = grossProfit - allocated
  // order costs, summed, PLUS shippingCharged (revenue that belongs to the
  // order, not to any single line). Summing the allocated shares (which
  // sum to orderCostsTotal by construction — allocate() distributes the
  // whole amount) rather than replicating the per-line allocateCost split
  // gives the identical order-level total without needing the allocation
  // method here at all (confirmSale allocates by revenue share, which only
  // matters for the PER-LINE breakdown, not this summary total).
  const netProfitTotal = grossProfitTotal - orderCostsTotal + shippingChargedMinor;
  const revenueForMargin = subtotal + shippingChargedMinor;
  const marginPct = revenueForMargin > 0 ? Math.round((netProfitTotal / revenueForMargin) * 10_000) : null;

  const paidAmountMinor = paidAmount.trim() !== "" ? toMinor(paidAmount) : 0;
  const paymentValid = paidAmountMinor <= 0 || (!!accountId && paidAmountMinor <= grandTotal);

  const canSubmit = !!warehouseId && validComputed.length > 0 && !hasDiscountError && paymentValid;

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    if (customerId) fd.set("customerId", customerId);
    fd.set("warehouseId", warehouseId);
    fd.set("channel", channel);
    if (orderDate) fd.set("orderDate", orderDate);
    if (notes) fd.set("notes", notes);
    if (shippingCharged.trim() !== "") fd.set("shippingCharged", shippingCharged);
    fd.set("linesJson", JSON.stringify(validComputed.map((l) => ({
      productId: l.productId,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice || 0),
      discountAmount: Number(l.discount || 0),
      taxRatePct: Number(l.taxRatePct || 0),
    }))));
    fd.set("costsJson", JSON.stringify(validCosts.map((c) => ({
      costType: c.costType,
      description: c.description || undefined,
      amount: Number(c.amount || 0),
    }))));
    if (paidAmountMinor > 0) {
      fd.set("paidAmount", paidAmount);
      fd.set("accountId", accountId);
    }
    try {
      const res = await createSalesOrderAction(fd);
      setResult(res);
      if (res.ok) router.push(`/${locale}/sales/${res.data.salesOrderId}`);
    } catch (error) {
      console.error("Create sale request failed:", error);
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
        <FormField label={labels.customer}>
          <CustomerPicker
            customers={customers}
            value={customerId}
            onChangeAction={setCustomerId}
            placeholder={labels.customerSearchPlaceholder}
            walkInLabel={labels.walkIn}
          />
        </FormField>
        <FormField label={labels.warehouse} required>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </FormField>
        <FormField label={labels.channel} required>
          <select value={channel} onChange={(e) => setChannel(e.target.value as SalesChannel)} className={inputClass}>
            {(Object.keys(labels.channelOptions) as SalesChannel[]).map((c) => (
              <option key={c} value={c}>{labels.channelOptions[c]}</option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.orderDate}>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className={inputClass} />
        </FormField>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{labels.product}</h2>
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface">
              <tr>
                <th className="px-3 py-2 text-start font-medium text-muted">{labels.product}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.availableStock}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.quantity}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.unitPrice}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.discount}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.tax}</th>
                <th className="px-3 py-2 text-end font-medium text-muted">{labels.lineTotal}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {computed.map((line) => (
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
                  <td className="px-3 py-2 text-end text-muted">
                    {line.productId ? formatQty(stockForWarehouse[line.productId] ?? 0, locale) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} step="0.001" value={line.quantity}
                      onChange={(e) => setLine(line.key, "quantity", e.target.value)}
                      className={`${inputClass} w-24 text-end ${line.insufficientStock ? "border-warning" : ""}`}
                    />
                    {line.insufficientStock ? (
                      <span className="mt-1 block text-xs text-warning">
                        {fillTemplate(labels.stockWarningTemplate, { available: formatQty(line.available, locale) })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} step="0.01" value={line.unitPrice}
                      onChange={(e) => setLine(line.key, "unitPrice", e.target.value)}
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
        <h2 className="text-sm font-semibold">{labels.orderCosts}</h2>
        {costs.map((cost) => (
          <div key={cost.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-3">
            <div className="w-48">
              <FormField label={labels.costType}>
                <select
                  value={cost.costType}
                  onChange={(e) => setCost(cost.key, "costType", e.target.value as OrderCostType)}
                  className={inputClass}
                >
                  <option value="">—</option>
                  {COST_TYPE_CHOICES.map((ct) => (
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label={labels.shippingCharged}>
          <input
            type="number" min={0} step="0.01" value={shippingCharged}
            onChange={(e) => setShippingCharged(e.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.notes}>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </FormField>
      </div>

      {canPay ? (
        <div className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">{labels.recordPayment}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label={labels.paidAmount}>
              <input
                type="number" min={0} max={fromMinor(grandTotal) > 0 ? fromMinor(grandTotal) : undefined} step="0.01"
                value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label={labels.account} required={paidAmountMinor > 0}>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{labels.summary}</h2>
        <dl className="grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-muted">{labels.subtotal}</dt>
          <dd className="text-end"><Money minor={subtotal} locale={locale} currency={currency} /></dd>
          <dt className="text-muted">{labels.discountTotal}</dt>
          <dd className="text-end"><Money minor={discountTotal} locale={locale} currency={currency} /></dd>
          <dt className="text-muted">{labels.taxTotal}</dt>
          <dd className="text-end"><Money minor={taxTotal} locale={locale} currency={currency} /></dd>
          <dt className="text-muted">{labels.shippingCharged}</dt>
          <dd className="text-end"><Money minor={shippingChargedMinor} locale={locale} currency={currency} /></dd>
        </dl>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="font-semibold">{labels.grandTotal}</span>
          <span className="text-lg font-semibold">
            <Money minor={grandTotal} locale={locale} currency={currency} />
          </span>
        </div>

        {canViewProfit ? (
          <dl className="mt-4 grid grid-cols-2 gap-y-1 border-t border-line pt-3 text-sm sm:grid-cols-4">
            <dt className="text-muted">{labels.revenue}</dt>
            <dd className="text-end"><Money minor={revenueForMargin} locale={locale} currency={currency} /></dd>
            <dt className="text-muted">{labels.productCost}</dt>
            <dd className="text-end"><Money minor={productCostTotal} locale={locale} currency={currency} /></dd>
            <dt className="text-muted">{labels.grossProfit}</dt>
            <dd className="text-end"><Money minor={grossProfitTotal} locale={locale} currency={currency} tone="auto" /></dd>
            <dt className="text-muted">{labels.orderCostsTotal}</dt>
            <dd className="text-end"><Money minor={orderCostsTotal} locale={locale} currency={currency} /></dd>
            <dt className="font-semibold text-navy">{labels.netProfit}</dt>
            <dd className="text-end text-base font-semibold">
              <Money minor={netProfitTotal} locale={locale} currency={currency} tone="auto" />
            </dd>
            <dt className="text-muted">{labels.margin}</dt>
            <dd className="text-end">{marginPct !== null ? formatPct(marginPct, locale) : "—"}</dd>
          </dl>
        ) : null}
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
            message={labels.confirmMessage}
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

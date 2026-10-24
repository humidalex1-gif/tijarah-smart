"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { addExpenseAction, cancelExpenseAction } from "../expenses/actions";
import { recordSupplierPaymentAction } from "../finance/actions";
import { createSalesOrderAction } from "../sales/actions";
import { createProductAction } from "../products/actions";
import { fillTemplate, type Locale } from "@/lib/i18n";
import { formatMoney, formatNumber } from "@/lib/format";
import { toMinor, fromMinor } from "@/lib/money";

/**
 * Quick entry — a FACE over operations that already exist.
 *
 * Every save here calls the same tested server action the full screen calls
 * (`addExpenseAction`, which already accepts a `file` and passes it through
 * `withAttachment`). No new table, no new calculation, no schema push:
 * deleting this file tomorrow changes no figure in the books.
 *
 * Stage 1 is the expense path only. The other three home buttons are rendered
 * DISABLED rather than omitted, so the shape of the finished page is visible
 * while nothing on screen can be pressed into a route that is not built — the
 * defect that made the first attempt at this page unshippable.
 *
 * Deliberately absent, and it is not an oversight: goods receiving,
 * reconciliation and warehouse invoices stay on the full screens. A wrong
 * default in those corrupts figures silently, and this project has paid for
 * that once already.
 */

export interface QuickEntryLabels {
  greeting: string; salesToday: string;
  expense: string; expenseHint: string; sale: string; saleHint: string;
  product: string; productHint: string; payment: string; paymentHint: string;
  soon: string; newExpense: string; next: string; category: string;
  invoice: string; optional: string; snap: string; snapDone: string; snapClear: string;
  save: string; saving: string; back: string; saved: string; fromTemplate: string;
  newSale: string; total: string; recordSale: string;
  newProduct: string; productName: string; productPrice: string;
  saveProduct: string; productLater: string;
  newPayment: string; payTo: string; savePayment: string;
  undo: string; undone: string; undoReason: string;
  errors: Record<string, string>;
}

/** `sellingPrice` is minor units, exactly as `Product` stores it. */
export interface QuickSaleProduct {
  id: string;
  nameAr: string;
  nameEn: string;
  sellingPrice: number;
}

interface Category { id: string; nameAr: string; nameEn: string }

/**
 * Western digits under `/ar` is a defect this project has already shipped
 * once, on the reconcile screen. The amount is held as an ASCII string
 * because that is what the action's `z.coerce.number()` parses; only its
 * DISPLAY is localized.
 */
function localizeDigits(raw: string, locale: Locale): string {
  const decimal = formatNumber(1.1, locale).charAt(1);
  return raw
    .replace(/\d/g, (d) => formatNumber(Number(d), locale))
    .replace(".", decimal);
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

/**
 * PENDING- is this project's convention for "real SKU not captured yet": such
 * products deliberately do not sync with Fast Hub until the owner replaces the
 * code from the full screen — the honest failure mode. Module level, not in
 * the component: the react-hooks purity rule rightly refuses Date.now() in
 * component scope, and here it runs only inside the click handler.
 */
function mintPendingSku(): string {
  return `PENDING-Q-${Date.now().toString(36).toUpperCase()}`;
}

/** What a keypad key reads as on screen: digits and the decimal separator are
 *  locale-specific, backspace is a symbol in both. */
function keyLabel(key: string, locale: Locale): string {
  if (key === "⌫") return key;
  // "1.1" localized is "١٫١", whose middle character is the separator Arabic
  // actually uses (U+066B), not the ASCII dot the value is stored with.
  if (key === ".") return localizeDigits("1.1", locale).charAt(1);
  return localizeDigits(key, locale);
}

export function QuickEntry({
  locale, currency, categories, accountId, accountName, today, sale, productEntry = false, payment, canUndo = false, labels,
}: {
  locale: Locale;
  currency: string;
  categories: Category[];
  accountId: string;
  accountName: string;
  // `ordersLabel` arrives already translated: `dashboard.orders` is an Arabic
  // plural-rules object (لا توجد / طلب واحد / طلبان / طلبات), which only the
  // server's translator resolves — a `{count}` template filled on the client
  // would render "٢ طلب" where Arabic says "طلبان".
  // Absent for a role without `sales.view`. Built on the server only when it
  // is allowed: computing it into props for this `"use client"` component
  // would ship the figure in the RSC payload even with the card hidden.
  today?: { revenue: number; ordersLabel: string };
  /**
   * Absent when the role lacks `sales.create`+`payments.create`, and the sale
   * button stays disabled — absence of the prop IS the gate the page computed.
   * The quick sale is one submit through `createSalesOrderAction`, the same
   * create-and-confirm the full form makes, so a mis-tap is recoverable the
   * same way any sale is: cancelled or returned from the sales screen.
   */
  sale?: { warehouseId: string; products: QuickSaleProduct[] };
  /** True when the role holds `products.create`+`inventory.receive`. */
  productEntry?: boolean;
  /**
   * Absent when the role lacks `payments.create`+`purchases.view` — the same
   * pair the full payment form demands. The quick payment goes to a supplier
   * from the page's named default account; anything richer (a PO, a
   * reference, a receipt) belongs on the finance screen.
   */
  payment?: { suppliers: { id: string; name: string }[] };
  /** True when the role holds `expenses.cancel`; gates the undo button. */
  canUndo?: boolean;
  labels: QuickEntryLabels;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [screen, setScreen] = useState<"home" | "amount" | "category" | "sale" | "product" | "payment">("home");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // Sale quantities by product id; entries are only ever 0 or positive.
  const [qty, setQty] = useState<Record<string, number>>({});
  const [productName, setProductName] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [paySupplierId, setPaySupplierId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The id the expense save returned, held only so undo can name it. Cleared
  // by every other save path: an Undo button left over from an earlier
  // expense, shown under a SALE's toast, would cancel the wrong record.
  const [savedExpenseId, setSavedExpenseId] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // A ref as well as the state: two taps in the same tick both read the same
  // stale `submitting` closure, so a state-only check does not block the
  // second one. Same guard as every other mutation form in this app.
  const submittingRef = useRef(false);

  const amountNum = Number(amount);
  const amountIsPositive = amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const category = categories.find((c) => c.id === categoryId);
  const categoryName = category ? (locale === "ar" ? category.nameAr : category.nameEn) : "";

  function go(next: "home" | "amount" | "category" | "sale" | "product" | "payment") {
    setSaved(false);
    setSavedExpenseId(null);
    setUndone(false);
    setError(null);
    /**
     * Crossing the home screen ends a flow, so what was typed for the
     * abandoned one must not be waiting in the next. Without this, 250 typed
     * on the expense keypad and walked away from is still 250 when the
     * payment screen opens — and that screen's Save moves real money to a
     * supplier. The same carry-over applied to the attached invoice photo,
     * the chosen category and the sale quantities.
     *
     * Only on that boundary, never on every navigation: the amount screen's
     * own Continue goes to the category screen and the back arrow returns,
     * both inside ONE expense, and clearing there would erase the figure the
     * owner is in the middle of entering.
     */
    if (next === "home" || screen === "home") reset();
    setScreen(next);
  }

  function reset() {
    setAmount("");
    setCategoryId("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setQty({});
    setProductName("");
    setProductPrice("");
    setPaySupplierId("");
    setError(null);
  }

  function press(key: string) {
    setSaved(false);
    setAmount((current) => {
      if (key === "⌫") return current.slice(0, -1);
      if (key === ".") return current.includes(".") ? current : `${current || "0"}.`;
      // Seven significant digits is more than any expense this business
      // records, and it stops a stuck finger producing an unreadable figure.
      if (current.replace(".", "").length >= 7) return current;
      return current + key;
    });
  }

  async function save() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const fd = new FormData();
    fd.set("categoryId", categoryId);
    // The action requires an account and a description, and this page asks for
    // neither: the account is the company's first active one (named on screen,
    // never silent) and the description is the category, so the expense list
    // does not show a blank line for every quick entry.
    fd.set("accountId", accountId);
    fd.set("description", categoryName);
    fd.set("amount", amount);
    // Only when a photo was actually taken: an empty File fails saveUpload's
    // size guard and would refuse an expense that never wanted a document.
    if (file) fd.set("file", file);

    try {
      const res = await addExpenseAction(fd);
      if (res.ok) {
        reset();
        setSaved(true);
        setSavedExpenseId(res.data.expenseId);
        setUndone(false);
        setScreen("home");
        // The dashboard figure at the top of this page is server-rendered.
        router.refresh();
      } else {
        // Staying put is the point: bouncing home on a failure loses the
        // entry silently and reads exactly like success.
        setError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (e) {
      console.error("Quick expense failed:", e);
      setError(labels.errors["errors.generic"]);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /**
   * Undoes the expense the toast is standing over — nothing else.
   *
   * Through `cancelExpenseAction`, the same audited cancel the expense screen
   * uses: the row is marked cancelled with a reason, never deleted, so the
   * trail survives (rule: nothing here invents a write path). The id is the
   * one the SAVE returned; every non-expense save path clears it.
   */
  async function undo() {
    if (submittingRef.current || !savedExpenseId) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const fd = new FormData();
    fd.set("expenseId", savedExpenseId);
    // The cancel action refuses without a reason, and the audit trail keeps
    // it — so the undo names itself honestly.
    fd.set("reason", labels.undoReason);

    try {
      const res = await cancelExpenseAction(fd);
      if (res.ok) {
        setSavedExpenseId(null);
        setUndone(true);
        router.refresh();
      } else {
        // The expense still exists; saying "cancelled" here would be a
        // success message about a failure.
        setError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (e) {
      console.error("Quick undo failed:", e);
      setError(labels.errors["errors.generic"]);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function savePayment() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const fd = new FormData();
    fd.set("supplierId", paySupplierId);
    // The same named-on-screen default account the expense path uses.
    fd.set("accountId", accountId);
    fd.set("amount", amount);

    try {
      const res = await recordSupplierPaymentAction(fd);
      if (res.ok) {
        reset();
        setSaved(true);
        setSavedExpenseId(null);
        setScreen("home");
        router.refresh();
      } else {
        setError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (e) {
      console.error("Quick payment failed:", e);
      setError(labels.errors["errors.generic"]);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const saleTotalMinor = sale
    ? sale.products.reduce((sum, p) => sum + (qty[p.id] ?? 0) * p.sellingPrice, 0)
    : 0;

  function step(productId: string, delta: number) {
    setSaved(false);
    setQty((current) => ({
      ...current,
      [productId]: Math.max(0, (current[productId] ?? 0) + delta),
    }));
  }

  async function saveSale() {
    if (!sale || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const fd = new FormData();
    fd.set("warehouseId", sale.warehouseId);
    // The action's schema takes SAR and converts via toMinor/toQty itself,
    // exactly as it does for the full form — sending minor units here would
    // book a 100x price.
    fd.set("linesJson", JSON.stringify(
      sale.products
        .filter((p) => (qty[p.id] ?? 0) > 0)
        .map((p) => ({
          productId: p.id,
          quantity: qty[p.id]!,
          unitPrice: fromMinor(p.sellingPrice),
          // Zero on purpose: every real SokuDry order (the Fast Hub import)
          // books tax-inclusive storefront prices with taxRatePct 0. The quick
          // sale matches the BOOKS, not the full form's company-default
          // suggestion — mixing the two treatments in one ledger would make
          // the same product's margin differ by channel for no real reason.
          taxRatePct: 0,
        })),
    ));
    fd.set("costsJson", "[]");
    // Paid in full into the named account: a quick sale is cash in hand, and
    // an unpaid sale against NO customer would be a receivable that surfaces
    // on no screen — `receivables()` reads customer balances.
    fd.set("paidAmount", String(fromMinor(saleTotalMinor)));
    fd.set("accountId", accountId);

    try {
      const res = await createSalesOrderAction(fd);
      if (res.ok) {
        reset();
        setSaved(true);
        setScreen("home");
        router.refresh();
      } else {
        // INSUFFICIENT_STOCK lands here: confirmSale enforces the floor and
        // rolls the whole order back, so staying put with the quantities
        // intact lets the owner correct one line instead of retyping five.
        setError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (e) {
      console.error("Quick sale failed:", e);
      setError(labels.errors["errors.generic"]);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const productPriceNum = Number(productPrice);
  const productValid = productName.trim() !== ""
    && productPrice.trim() !== "" && Number.isFinite(productPriceNum) && productPriceNum > 0;

  async function saveProduct() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const fd = new FormData();
    // The action requires nameAr, nameEn and sku; this form asks one name.
    // Both languages get it — the seed does the same — and the full products
    // screen refines later.
    fd.set("nameAr", productName.trim());
    fd.set("nameEn", productName.trim());
    fd.set("sku", mintPendingSku());
    fd.set("sellingPrice", productPrice);
    fd.set("trackInventory", "on");
    // Deliberately NO openingQty: opening stock posts a real movement, and a
    // figure invented at a checkout counter is how shelves and books diverge.

    try {
      const res = await createProductAction(fd);
      if (res.ok) {
        reset();
        setSaved(true);
        setScreen("home");
        router.refresh();
      } else {
        setError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (e) {
      console.error("Quick product failed:", e);
      setError(labels.errors["errors.generic"]);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const tile = "flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-panel"
    + " p-5 text-base font-bold text-navy transition active:scale-[.97]"
    + " disabled:opacity-40 disabled:active:scale-100";

  return (
    <div className="mx-auto flex min-h-[32rem] max-w-md flex-col">
      {screen === "home" ? (
        <>
          <p className="mb-3 text-sm text-muted">{labels.greeting}</p>

          {today ? (
            <div className="mb-5 rounded-2xl border border-line bg-panel p-4">
              <div className="text-xs text-muted">{labels.salesToday}</div>
              <div className="text-3xl font-extrabold tabular-nums text-navy">
                {formatMoney(today.revenue, locale, currency)}
              </div>
              <div className="text-xs text-muted">{today.ordersLabel}</div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <button type="button" className={tile} onClick={() => go("amount")}>
              <span aria-hidden className="text-2xl">🧾</span>
              {labels.expense}
              <small className="text-xs font-normal text-muted">{labels.expenseHint}</small>
            </button>
            {/* Enabled only when the page supplied their data — absence of
                the prop is the permission gate it computed. A live button
                whose action would refuse is the defect this page exists to
                avoid. */}
            <button
              type="button"
              disabled={!sale || sale.products.length === 0}
              className={tile}
              onClick={() => go("sale")}
            >
              <span aria-hidden className="text-2xl">🛒</span>
              {labels.sale}
              <small className="text-xs font-normal text-muted">{labels.saleHint}</small>
            </button>
            <button
              type="button"
              disabled={!productEntry}
              className={tile}
              onClick={() => go("product")}
            >
              <span aria-hidden className="text-2xl">📦</span>
              {labels.product}
              <small className="text-xs font-normal text-muted">{labels.productHint}</small>
            </button>
            <button
              type="button"
              disabled={!payment || payment.suppliers.length === 0}
              className={tile}
              onClick={() => go("payment")}
            >
              <span aria-hidden className="text-2xl">💳</span>
              {labels.payment}
              <small className="text-xs font-normal text-muted">{labels.paymentHint}</small>
            </button>
          </div>

          {saved || undone ? (
            <div className="mt-5 rounded-xl border border-success bg-panel p-3 text-center">
              <p className="font-bold text-success">{undone ? labels.undone : labels.saved}</p>
              {/* Only over the expense whose id the save just returned, and
                  only for a role that can cancel — a button whose action
                  would refuse is the defect this page exists to avoid. */}
              {!undone && canUndo && savedExpenseId ? (
                <button
                  type="button"
                  onClick={undo}
                  disabled={submitting}
                  className="mt-2 rounded-lg border border-line px-4 py-1.5 text-sm text-navy disabled:opacity-60"
                >
                  {labels.undo}
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        </>
      ) : null}

      {screen === "amount" ? (
        <>
          <Head label={labels.newExpense} back={labels.back} onBack={() => go("home")} />
          <div
            data-testid="quick-amount"
            className="py-5 text-center text-5xl font-extrabold tabular-nums text-navy"
          >
            {localizeDigits(amount || "0", locale)}
          </div>
          <div className="mt-auto grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                className="rounded-xl border border-line bg-panel py-3 text-xl font-semibold text-navy active:bg-surface"
              >
                {keyLabel(k, locale)}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={!amountIsPositive}
            onClick={() => go("category")}
            className="mt-3 w-full rounded-xl bg-brand p-3.5 font-bold text-brand-ink disabled:opacity-35"
          >
            {labels.next}
          </button>
        </>
      ) : null}

      {screen === "category" ? (
        <>
          <Head label={labels.newExpense} back={labels.back} onBack={() => go("amount")} />
          <div className="pt-1 text-center text-2xl font-extrabold tabular-nums text-navy">
            {formatMoney(toMinor(amountNum), locale, currency)}
          </div>

          <div className="mt-4 text-xs text-muted">{labels.category}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {categories.map((c) => {
              const selected = c.id === categoryId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { setCategoryId(c.id); setError(null); }}
                  className={`rounded-full border px-4 py-2 text-sm ${
                    selected
                      ? "border-brand bg-brand font-bold text-brand-ink"
                      : "border-line bg-panel text-navy"
                  }`}
                >
                  {locale === "ar" ? c.nameAr : c.nameEn}
                </button>
              );
            })}
          </div>

          <div className="mt-4 text-xs text-muted">
            {labels.invoice} <span className="opacity-70">({labels.optional})</span>
          </div>
          {/* `capture` asks a phone for the camera directly. The file still
              rides the ordinary attachment path — it is uploaded WITH the
              save, so abandoning the entry leaves nothing behind. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.pdf"
            capture="environment"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={`flex-1 rounded-xl border p-3 text-sm ${
                file ? "border-success text-success" : "border-dashed border-line text-muted"
              }`}
            >
              {file ? `✓ ${labels.snapDone}` : `\u{1F4F7} ${labels.snap}`}
            </button>
            {file ? (
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
                className="text-sm text-muted"
              >
                {labels.snapClear}
              </button>
            ) : null}
          </div>

          {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}

          <p className="mt-auto pt-4 text-center text-xs text-muted">
            {fillTemplate(labels.fromTemplate, { account: accountName })}
          </p>
          <button
            type="button"
            disabled={!categoryId || !amountIsPositive || submitting}
            onClick={save}
            className="mt-2 w-full rounded-xl bg-brand p-3.5 font-bold text-brand-ink disabled:opacity-35"
          >
            {submitting ? labels.saving : labels.save}
          </button>
        </>
      ) : null}

      {screen === "sale" && sale ? (
        <>
          <Head label={labels.newSale} back={labels.back} onBack={() => go("home")} />
          <div className="flex-1 space-y-2 overflow-y-auto">
            {sale.products.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-navy">
                    {locale === "ar" ? p.nameAr : p.nameEn}
                  </div>
                  <div className="text-xs tabular-nums text-muted">
                    {formatMoney(p.sellingPrice, locale, currency)}
                  </div>
                </div>
                {/* 44px, not 32: these are the most repeatedly tapped controls in the
                    product — several taps per line, standing, one-handed — and an
                    over-tap on a 32px target lands on the next product row. */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => step(p.id, -1)}
                    className="h-11 w-11 rounded-lg border border-line bg-surface text-navy"
                  >
                    -
                  </button>
                  <span className="min-w-8 text-center font-bold tabular-nums text-navy">
                    {formatNumber(qty[p.id] ?? 0, locale)}
                  </span>
                  <button
                    type="button"
                    onClick={() => step(p.id, 1)}
                    className="h-11 w-11 rounded-lg border border-line bg-surface text-navy"
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-3">
            <span className="text-sm text-muted">{labels.total}</span>
            <span data-testid="quick-sale-total" className="text-xl font-extrabold tabular-nums text-navy">
              {formatMoney(saleTotalMinor, locale, currency)}
            </span>
          </div>
          {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
          <p className="mt-1 text-center text-xs text-muted">
            {fillTemplate(labels.fromTemplate, { account: accountName })}
          </p>
          <button
            type="button"
            disabled={saleTotalMinor <= 0 || submitting}
            onClick={saveSale}
            className="mt-2 w-full rounded-xl bg-brand p-3.5 font-bold text-brand-ink disabled:opacity-35"
          >
            {submitting ? labels.saving : labels.recordSale}
          </button>
        </>
      ) : null}

      {screen === "product" ? (
        <>
          <Head label={labels.newProduct} back={labels.back} onBack={() => go("home")} />
          <div className="mt-2 space-y-4">
            <div>
              <label htmlFor="quick-product-name" className="text-xs text-muted">
                {labels.productName}
              </label>
              <input
                id="quick-product-name"
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-panel p-3 text-navy"
              />
            </div>
            <div>
              <label htmlFor="quick-product-price" className="text-xs text-muted">
                {labels.productPrice}
              </label>
              <input
                id="quick-product-price"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={productPrice}
                onChange={(e) => setProductPrice(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-panel p-3 tabular-nums text-navy"
              />
            </div>
            <p className="text-xs text-muted">{labels.productLater}</p>
          </div>
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
          <div className="mt-auto" />
          <button
            type="button"
            disabled={!productValid || submitting}
            onClick={saveProduct}
            className="mt-2 w-full rounded-xl bg-brand p-3.5 font-bold text-brand-ink disabled:opacity-35"
          >
            {submitting ? labels.saving : labels.saveProduct}
          </button>
        </>
      ) : null}

      {screen === "payment" && payment ? (
        <>
          <Head label={labels.newPayment} back={labels.back} onBack={() => go("home")} />
          <div
            data-testid="quick-pay-amount"
            className="py-5 text-center text-5xl font-extrabold tabular-nums text-navy"
          >
            {localizeDigits(amount || "0", locale)}
          </div>

          <div className="text-xs text-muted">{labels.payTo}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {payment.suppliers.map((supplier) => {
              const selected = supplier.id === paySupplierId;
              return (
                <button
                  key={supplier.id}
                  type="button"
                  onClick={() => { setPaySupplierId(supplier.id); setError(null); }}
                  className={`rounded-full border px-4 py-2 text-sm ${
                    selected
                      ? "border-brand bg-brand font-bold text-brand-ink"
                      : "border-line bg-panel text-navy"
                  }`}
                >
                  {supplier.name}
                </button>
              );
            })}
          </div>

          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

          <div className="mt-auto grid grid-cols-3 gap-2 pt-4">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                className="rounded-xl border border-line bg-panel py-3 text-xl font-semibold text-navy active:bg-surface"
              >
                {keyLabel(k, locale)}
              </button>
            ))}
          </div>
          <p className="mt-3 text-center text-xs text-muted">
            {fillTemplate(labels.fromTemplate, { account: accountName })}
          </p>
          <button
            type="button"
            disabled={!amountIsPositive || paySupplierId === "" || submitting}
            onClick={savePayment}
            className="mt-2 w-full rounded-xl bg-brand p-3.5 font-bold text-brand-ink disabled:opacity-35"
          >
            {submitting ? labels.saving : labels.savePayment}
          </button>
        </>
      ) : null}
    </div>
  );
}

function Head({ label, back, onBack }: { label: string; back: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3 pb-2">
      <button
        type="button"
        onClick={onBack}
        aria-label={back}
        className="h-9 w-9 rounded-xl border border-line bg-panel text-navy"
      >
        <span aria-hidden>{"←"}</span>
      </button>
      <h2 className="text-base font-semibold text-navy">{label}</h2>
    </div>
  );
}

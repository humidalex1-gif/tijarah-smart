"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClass } from "@/components/ui/FormField";

type Labels = Record<
  | "openTitle" | "product" | "warehouse" | "kind" | "quantity" | "notes"
  | "open" | "opened" | "generic"
  | "kindRETURN" | "kindDAMAGE" | "kindSHORTAGE",
  string
>;

/**
 * Opening a claim by hand: "these units went back / were damaged, and the
 * warehouse has not confirmed it". Until the Salla sync exists this is the
 * only source of claims, and without claims the reconciliation has nothing to
 * attribute a difference to.
 */
export function OpenClaimForm({
  products, warehouses, kinds, labels,
}: {
  products: { id: string; name: string }[];
  warehouses: { id: string; name: string }[];
  kinds: string[];
  labels: Labels;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opening a claim moves stock and is not idempotent. A state flag alone does
  // not stop a synchronous double-click.
  const submittingRef = useRef(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setMessage(null);
    setError(null);

    const form = event.currentTarget;
    try {
      const { openClaimAction } = await import("./actions");
      const result = await openClaimAction(new FormData(form));
      if (result.ok) {
        setMessage(labels.opened);
        form.reset();
        router.refresh();
      } else {
        setError(result.error ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  }

  if (products.length === 0 || warehouses.length === 0) return null;

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-4">
      <div className="w-full text-sm font-medium">{labels.openTitle}</div>

      <FormField label={labels.product} required>
        <select name="productId" required className={`${inputClass} w-auto`}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </FormField>

      <FormField label={labels.warehouse} required>
        <select name="warehouseId" required className={`${inputClass} w-auto`}>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </FormField>

      <FormField label={labels.kind} required>
        <select name="kind" required className={`${inputClass} w-auto`}>
          {kinds.map((k) => (
            <option key={k} value={k}>{labels[`kind${k}` as keyof Labels]}</option>
          ))}
        </select>
      </FormField>

      <FormField label={labels.quantity} required>
        <input
          // min matches the server's floor: quantities are thousandths, so
          // 0.001 is the smallest claimable amount. min="0" let a zero through
          // to a zod rejection the form could only render as a generic error.
          type="number" name="quantity" required min="0.001" step="any" inputMode="decimal"
          className={`${inputClass} w-28 text-end`}
        />
      </FormField>

      <FormField label={labels.notes}>
        <input type="text" name="notes" className={`${inputClass} w-auto`} />
      </FormField>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:opacity-50"
      >
        {labels.open}
      </button>

      {message ? <p className="w-full text-sm text-success">{message}</p> : null}
      {error ? <p className="w-full text-sm text-danger">{error}</p> : null}
    </form>
  );
}

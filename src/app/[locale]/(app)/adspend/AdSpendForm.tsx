"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClass } from "@/components/ui/FormField";

type Labels = Record<
  | "channel" | "periodStart" | "periodEnd" | "amount" | "product"
  | "campaign" | "allProducts" | "add" | "recorded" | "generic",
  string
>;

export function AdSpendForm({
  channels, products, labels,
}: {
  channels: { value: string; label: string }[];
  products: { id: string; name: string }[];
  labels: Labels;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Recording spend is not idempotent, and a state flag alone does not stop a
  // synchronous double-click — React batches the update and the second
  // handler runs against the old value.
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
      const { recordAdSpendAction } = await import("./actions");
      const result = await recordAdSpendAction(new FormData(form));
      if (result.ok) {
        setMessage(labels.recorded);
        form.reset();
        router.refresh();
      } else {
        setError(result.error ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      // try/finally, not finally-only: a rejected transport would otherwise
      // leave the form permanently disabled.
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-4">
      <FormField label={labels.channel} required>
        <select name="channel" required className={`${inputClass} w-auto`}>
          {/* The value stays the stored enum; only the label is translated. */}
          {channels.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </FormField>

      <FormField label={labels.periodStart} required>
        <input type="date" name="periodStart" required className={`${inputClass} w-auto`} />
      </FormField>

      <FormField label={labels.periodEnd} required>
        <input type="date" name="periodEnd" required className={`${inputClass} w-auto`} />
      </FormField>

      <FormField label={labels.amount} required>
        <input
          type="number" name="amount" required min="0" step="0.01" inputMode="decimal"
          className={`${inputClass} w-32 text-end`}
        />
      </FormField>

      <FormField label={labels.product}>
        <select name="productId" className={`${inputClass} w-auto`}>
          {/* Blank means untagged: pooled and allocated by revenue on read. */}
          <option value="">{labels.allProducts}</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </FormField>

      <FormField label={labels.campaign}>
        <input type="text" name="campaign" className={`${inputClass} w-auto`} />
      </FormField>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:opacity-50"
      >
        {labels.add}
      </button>

      {message ? <p className="w-full text-sm text-success">{message}</p> : null}
      {error ? <p className="w-full text-sm text-danger">{error}</p> : null}
    </form>
  );
}

"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";

export interface FilterOption { id: string; label: string }

export function MovementFilters({
  warehouses, products, types, current, labels,
}: {
  warehouses: FilterOption[];
  products: FilterOption[];
  types: FilterOption[];
  current: { warehouse: string; product: string; type: string; from: string; to: string };
  labels: {
    warehouse: string; product: string; movementType: string; dateFrom: string; dateTo: string; all: string;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const formRef = useRef<HTMLFormElement>(null);

  function submit() {
    if (formRef.current) {
      const fd = new FormData(formRef.current);
      const params = new URLSearchParams();
      for (const [key, value] of fd.entries()) {
        if (typeof value === "string" && value.trim() !== "") params.set(key, value);
      }
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    }
  }

  return (
    <form
      ref={formRef}
      className="mb-4 flex flex-wrap items-end gap-3"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-xs text-muted">{labels.dateFrom}</span>
        <input type="date" name="from" defaultValue={current.from} onChange={submit} className={inputClass} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-muted">{labels.dateTo}</span>
        <input type="date" name="to" defaultValue={current.to} onChange={submit} className={inputClass} />
      </label>
      <select name="warehouse" defaultValue={current.warehouse} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.warehouse}: {labels.all}</option>
        {warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
      </select>
      <select name="product" defaultValue={current.product} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.product}: {labels.all}</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <select name="type" defaultValue={current.type} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.movementType}: {labels.all}</option>
        {types.map((mt) => <option key={mt.id} value={mt.id}>{mt.label}</option>)}
      </select>
    </form>
  );
}

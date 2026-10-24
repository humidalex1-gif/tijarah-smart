"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";

export interface FilterOption { id: string; label: string }

export function InventoryFilters({
  categories, warehouses, current, labels,
}: {
  categories: FilterOption[];
  warehouses: FilterOption[];
  current: { warehouse: string; category: string; stock: string };
  labels: {
    warehouse: string; category: string; stockStatus: string;
    all: string; inStock: string; lowStock: string; outOfStock: string;
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
      <select name="warehouse" defaultValue={current.warehouse} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.warehouse}: {labels.all}</option>
        {warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
      </select>
      <select name="category" defaultValue={current.category} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.category}: {labels.all}</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <select name="stock" defaultValue={current.stock} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.stockStatus}: {labels.all}</option>
        <option value="in">{labels.inStock}</option>
        <option value="low">{labels.lowStock}</option>
        <option value="out">{labels.outOfStock}</option>
      </select>
    </form>
  );
}

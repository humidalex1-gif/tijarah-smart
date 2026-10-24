"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";

export interface FilterOption { id: string; label: string }

export function ProductFilters({
  categories, brands, current, labels,
}: {
  categories: FilterOption[];
  brands: FilterOption[];
  current: { q: string; category: string; brand: string; stock: string; status: string };
  labels: {
    search: string; category: string; brand: string; stockStatus: string; status: string;
    all: string; inStock: string; lowStock: string; outOfStock: string; active: string; archived: string;
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
      <div className="min-w-[220px] flex-1">
        <input
          type="text" name="q" defaultValue={current.q} placeholder={labels.search}
          className={inputClass}
        />
      </div>
      <select name="category" defaultValue={current.category} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.category}: {labels.all}</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <select name="brand" defaultValue={current.brand} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.brand}: {labels.all}</option>
        {brands.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
      </select>
      <select name="stock" defaultValue={current.stock} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.stockStatus}: {labels.all}</option>
        <option value="in">{labels.inStock}</option>
        <option value="low">{labels.lowStock}</option>
        <option value="out">{labels.outOfStock}</option>
      </select>
      <select name="status" defaultValue={current.status} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.status}: {labels.all}</option>
        <option value="ACTIVE">{labels.active}</option>
        <option value="ARCHIVED">{labels.archived}</option>
      </select>
      <button type="submit" className="rounded-lg border border-line px-3 py-2 text-sm">
        {labels.search}
      </button>
    </form>
  );
}

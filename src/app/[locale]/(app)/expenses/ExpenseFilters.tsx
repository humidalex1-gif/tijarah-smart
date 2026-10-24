"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";

export interface FilterOption { id: string; label: string }

export function ExpenseFilters({
  categories, accounts, statuses, current, labels,
}: {
  categories: FilterOption[];
  accounts: FilterOption[];
  statuses: FilterOption[];
  current: { category: string; account: string; status: string; from: string; to: string };
  labels: {
    category: string; account: string; status: string; dateFrom: string; dateTo: string; all: string; search: string;
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
      <select name="category" defaultValue={current.category} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.category}: {labels.all}</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <select name="account" defaultValue={current.account} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.account}: {labels.all}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <select name="status" defaultValue={current.status} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.status}: {labels.all}</option>
        {statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </form>
  );
}

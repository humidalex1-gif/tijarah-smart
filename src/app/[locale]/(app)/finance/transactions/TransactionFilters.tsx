"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";

export interface FilterOption { id: string; label: string }

export function TransactionFilters({
  accounts, types, current, labels,
}: {
  accounts: FilterOption[];
  types: FilterOption[];
  current: { account: string; type: string; from: string; to: string };
  labels: { account: string; type: string; dateFrom: string; dateTo: string; all: string };
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
      <select name="account" defaultValue={current.account} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.account}: {labels.all}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <select name="type" defaultValue={current.type} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.type}: {labels.all}</option>
        {types.map((ty) => <option key={ty.id} value={ty.id}>{ty.label}</option>)}
      </select>
    </form>
  );
}

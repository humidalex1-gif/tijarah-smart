"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";
import type { SalesChannel } from "@/lib/constants";

export interface FilterOption { id: string; label: string }

export function SalesFilters({
  customers, current, labels,
}: {
  customers: FilterOption[];
  current: { customer: string; channel: string; status: string; paymentStatus: string; from: string; to: string };
  labels: {
    customer: string; channel: string; status: string; paymentStatus: string;
    dateFrom: string; dateTo: string; all: string;
    draft: string; confirmed: string; cancelled: string;
    unpaid: string; partial: string; paid: string;
    channelOptions: Record<SalesChannel, string>;
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
      <select name="customer" defaultValue={current.customer} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.customer}: {labels.all}</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <select name="channel" defaultValue={current.channel} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.channel}: {labels.all}</option>
        {Object.entries(labels.channelOptions).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      {/* Exactly DRAFT | CONFIRMED | CANCELLED — nothing in the posting
          engine ever sets COMPLETED on a sales order. */}
      <select name="status" defaultValue={current.status} onChange={submit} className={`${inputClass} w-auto`}>
        <option value="">{labels.status}: {labels.all}</option>
        <option value="DRAFT">{labels.draft}</option>
        <option value="CONFIRMED">{labels.confirmed}</option>
        <option value="CANCELLED">{labels.cancelled}</option>
      </select>
      <select
        name="paymentStatus" defaultValue={current.paymentStatus} onChange={submit}
        // The server drops paymentStatus outright once status=CANCELLED is
        // explicitly chosen (sales/page.tsx's `applyPaymentStatusFilter` —
        // same rationale as PurchaseFilters.tsx: a cancelled order's stored
        // paymentStatus is stale, docs/decisions.md #1). Disabling here makes
        // that inert state visible rather than silently ignored, and a
        // disabled <select> is excluded from this form's own FormData.
        disabled={current.status === "CANCELLED"}
        className={`${inputClass} w-auto disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <option value="">{labels.paymentStatus}: {labels.all}</option>
        <option value="UNPAID">{labels.unpaid}</option>
        <option value="PARTIAL">{labels.partial}</option>
        <option value="PAID">{labels.paid}</option>
      </select>
    </form>
  );
}

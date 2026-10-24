"use client";

import { useRouter, usePathname } from "next/navigation";
import { useRef } from "react";
import { inputClass } from "@/components/ui/FormField";

export function CustomerFilters({
  current, labels,
}: {
  current: { q: string; owing: boolean };
  labels: { search: string; owingOnly: string; all: string };
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
      className="mb-4 flex flex-wrap items-center gap-3"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <div className="min-w-[220px] flex-1">
        <input
          type="text" name="q" defaultValue={current.q} placeholder={labels.search}
          className={inputClass}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox" name="filter" value="owing" defaultChecked={current.owing}
          onChange={submit}
        />
        {labels.owingOnly}
      </label>
      <button type="submit" className="rounded-lg border border-line px-3 py-2 text-sm">
        {labels.search}
      </button>
    </form>
  );
}

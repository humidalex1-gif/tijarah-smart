"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SupplierForm, type SupplierFormLabels, type SupplierFormDefaults } from "../SupplierForm";
import type { Locale } from "@/lib/i18n";

export function SupplierEditSection({
  locale, supplierId, defaults, labels, editLabel,
}: {
  locale: Locale;
  supplierId: string;
  defaults: SupplierFormDefaults;
  labels: SupplierFormLabels;
  editLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-navy hover:bg-surface"
      >
        {editLabel}
      </button>
      {open ? (
        <div className="mt-4 rounded-xl border border-line bg-panel p-4">
          <SupplierForm
            locale={locale}
            mode="edit"
            supplierId={supplierId}
            defaults={defaults}
            labels={labels}
            onSavedAction={() => { setOpen(false); router.refresh(); }}
            onCancelAction={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

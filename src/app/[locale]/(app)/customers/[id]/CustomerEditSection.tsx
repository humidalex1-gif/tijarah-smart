"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CustomerForm, type CustomerFormLabels, type CustomerFormDefaults } from "../CustomerForm";
import type { Locale } from "@/lib/i18n";

export function CustomerEditSection({
  locale, customerId, defaults, labels, editLabel,
}: {
  locale: Locale;
  customerId: string;
  defaults: CustomerFormDefaults;
  labels: CustomerFormLabels;
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
          <CustomerForm
            locale={locale}
            mode="edit"
            customerId={customerId}
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

"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { archiveProductAction } from "../actions";
import type { Locale } from "@/lib/i18n";

export function ProductDetailActions({
  locale, productId, canEdit, canArchive, isArchived, labels,
}: {
  locale: Locale;
  productId: string;
  canEdit: boolean;
  canArchive: boolean;
  isArchived: boolean;
  labels: {
    edit: string; archive: string; archiveConfirmTitle: string; archiveConfirmMessage: string;
    confirm: string; cancel: string;
    // Keyed by the translation key archiveProductAction returns in `error`
    // (e.g. "errors.ALREADY_ARCHIVED"), pre-translated server-side — same
    // pattern as ExpenseDetailActions.tsx. Previously this collapsed every
    // failure to one hard-wired generic string (Stage 1B review, IMPORTANT 6).
    errors: Record<string, string>;
  };
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function handleArchive() {
    const fd = new FormData();
    fd.set("id", productId);
    const result = await archiveProductAction(fd);
    if (result.ok) {
      router.refresh();
    } else {
      setError(labels.errors[result.error] ?? labels.errors["errors.generic"]);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {canEdit ? (
        <Link
          href={`/${locale}/products/${productId}/edit`}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-navy hover:bg-surface"
        >
          {labels.edit}
        </Link>
      ) : null}
      {canArchive && !isArchived ? (
        <ConfirmDialog
          triggerLabel={labels.archive}
          title={labels.archiveConfirmTitle}
          message={labels.archiveConfirmMessage}
          confirmLabel={labels.confirm}
          cancelLabel={labels.cancel}
          onConfirmAction={handleArchive}
        />
      ) : null}
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelExpenseAction } from "../actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export interface ExpenseDetailActionsLabels {
  cancel: string; cancelReason: string; cancelTitle: string; cancelMessage: string;
  dismiss: string; confirm: string;
  errors: Record<string, string>;
}

export function ExpenseDetailActions({
  expenseId, canCancel, labels,
}: {
  expenseId: string;
  canCancel: boolean;
  labels: ExpenseDetailActionsLabels;
}) {
  const router = useRouter();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const cancelRef = useRef(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function handleCancel() {
    if (cancelRef.current || reason.trim() === "") return;
    cancelRef.current = true;
    setCancelSubmitting(true);
    const fd = new FormData();
    fd.set("expenseId", expenseId);
    fd.set("reason", reason);
    try {
      const res = await cancelExpenseAction(fd);
      if (res.ok) {
        setCancelOpen(false);
        setReason("");
        setCancelError(null);
        router.refresh();
      } else {
        setCancelError(res.error);
      }
    } catch (error) {
      console.error("Cancel expense request failed:", error);
      setCancelError("errors.generic");
    } finally {
      cancelRef.current = false;
      setCancelSubmitting(false);
    }
  }

  if (!canCancel) return null;

  return (
    <div>
      <ConfirmDialog
        triggerLabel={labels.cancel}
        title={labels.cancelTitle}
        message={labels.cancelMessage}
        confirmLabel={labels.confirm}
        cancelLabel={labels.dismiss}
        onConfirmAction={handleCancel}
        disabled={cancelSubmitting}
        field={{
          label: labels.cancelReason,
          value: reason,
          onChange: setReason,
          type: "textarea",
          required: true,
        }}
        error={cancelError ? (labels.errors[cancelError] ?? labels.errors["errors.generic"]) : null}
        open={cancelOpen}
        onOpenChangeAction={(next) => {
          setCancelOpen(next);
          if (!next) { setReason(""); setCancelError(null); }
        }}
      />
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { setUserPasswordAction } from "../actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fillTemplate } from "@/lib/i18n";

export interface ResetPasswordLabels {
  resetPassword: string; newPassword: string;
  resetConfirmTitle: string; resetConfirmMessageTemplate: string;
  dismiss: string; confirm: string;
  errors: Record<string, string>;
}

export function ResetPasswordButton({
  userId, userName, labels,
}: {
  userId: string;
  userName: string;
  labels: ResetPasswordLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (submittingRef.current || newPassword.trim().length < 8) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("userId", userId);
    fd.set("newPassword", newPassword);
    try {
      const res = await setUserPasswordAction(fd);
      if (res.ok) {
        setOpen(false);
        setNewPassword("");
        setError(null);
        router.refresh();
      } else {
        setError(res.error);
      }
    } catch (err) {
      console.error("Reset password request failed:", err);
      setError("errors.generic");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const message = fillTemplate(labels.resetConfirmMessageTemplate, { name: userName });

  return (
    <div>
      <ConfirmDialog
        triggerLabel={labels.resetPassword}
        title={labels.resetConfirmTitle}
        message={message}
        confirmLabel={labels.confirm}
        cancelLabel={labels.dismiss}
        tone="brand"
        onConfirmAction={handleReset}
        disabled={submitting}
        // Deliberately visible text, not a masked password field. This is an
        // OWNER typing a TEMPORARY password to hand to someone else, not
        // anyone entering their own secret: there is nothing to shoulder-surf
        // that the owner will not read aloud anyway. Masking it costs more
        // than it protects — there is no confirmation field, and a typo the
        // owner cannot see locks that user out with no in-app recovery path.
        // autoComplete is off for the same reason: the browser must not offer
        // to save someone else's temporary password as the owner's own.
        field={{
          label: labels.newPassword,
          value: newPassword,
          onChange: setNewPassword,
          type: "text",
          required: true,
          minLength: 8,
          autoComplete: "off",
        }}
        error={error ? (labels.errors[error] ?? labels.errors["errors.generic"]) : null}
        open={open}
        onOpenChangeAction={(next) => {
          setOpen(next);
          if (!next) { setNewPassword(""); setError(null); }
        }}
      />
    </div>
  );
}

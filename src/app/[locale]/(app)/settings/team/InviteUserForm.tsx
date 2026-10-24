"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { inviteUserAction } from "../actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField, inputClass } from "@/components/ui/FormField";
import type { Role } from "@/lib/constants";

export interface InviteUserFormLabels {
  fullName: string; email: string; tempPassword: string; role: string;
  roleOptions: Record<Role, string>;
  inviteUser: string; save: string; cancel: string; confirm: string; loading: string;
  inviteConfirmTitle: string; inviteConfirmMessage: string;
  errors: Record<string, string>;
}

export function InviteUserForm({ roles, labels }: { roles: Role[]; labels: InviteUserFormLabels }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(roles[roles.length - 1] ?? "VIEWER");
  const [result, setResult] = useState<Awaited<ReturnType<typeof inviteUserAction>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const canSubmit = fullName.trim() !== "" && email.trim() !== "" && password.trim().length >= 8;

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("fullName", fullName);
    fd.set("email", email);
    fd.set("password", password);
    fd.set("role", role);
    try {
      const res = await inviteUserAction(fd);
      setResult(res);
      if (res.ok) {
        setFullName("");
        setEmail("");
        setPassword("");
        setOpen(false);
        router.refresh();
      }
    } catch (error) {
      console.error("Invite user request failed:", error);
      setResult({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
      >
        {labels.inviteUser}
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold">{labels.inviteUser}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label={labels.fullName} required>
          <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.email} required>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.tempPassword} required>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        </FormField>
        <FormField label={labels.role} required>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
            {roles.map((r) => <option key={r} value={r}>{labels.roleOptions[r]}</option>)}
          </select>
        </FormField>
      </div>
      {result && !result.ok ? (
        <p className="mt-2 text-sm text-danger">{labels.errors[result.error] ?? labels.errors["errors.generic"]}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        {canSubmit ? (
          <ConfirmDialog
            triggerLabel={submitting ? labels.loading : labels.save}
            title={labels.inviteConfirmTitle}
            message={labels.inviteConfirmMessage}
            confirmLabel={labels.confirm}
            cancelLabel={labels.cancel}
            tone="brand"
            onConfirmAction={handleSubmit}
            disabled={submitting}
          />
        ) : (
          <button type="button" disabled className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink opacity-60">
            {labels.save}
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-4 py-2 text-sm">
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}

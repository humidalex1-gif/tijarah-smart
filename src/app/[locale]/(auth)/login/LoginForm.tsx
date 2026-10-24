"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";

export function LoginForm({
  locale, labels,
}: {
  locale: string;
  labels: { email: string; password: string; submit: string; error: string };
}) {
  const [state, formAction] = useActionState(loginAction, null);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />
      <FormField label={labels.email} required>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          className={inputClass}
        />
      </FormField>
      <FormField label={labels.password} required>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </FormField>
      {state?.error ? <p className="text-sm text-danger">{labels.error}</p> : null}
      <SubmitButton>{labels.submit}</SubmitButton>
    </form>
  );
}

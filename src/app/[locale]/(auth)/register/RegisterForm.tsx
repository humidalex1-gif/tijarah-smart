"use client";

import { useActionState } from "react";
import { registerAction } from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";

export function RegisterForm({
  locale, labels,
}: {
  locale: string;
  labels: {
    fullName: string;
    companyName: string;
    email: string;
    password: string;
    submit: string;
    // Keyed by the translation key registerAction returns in `error`
    // (e.g. "errors.EMAIL_ALREADY_REGISTERED"), pre-translated server-side.
    errors: Record<string, string>;
  };
}) {
  const [state, formAction] = useActionState(registerAction, null);
  const fields = state && "fields" in state ? state.fields : undefined;
  // A field's raw message is a dictionary KEY (e.g. "errors.INVALID_NAME",
  // from actions.ts's schema), not display text — resolved through
  // `labels.errors` before it reaches the screen, same as `errorMessage`
  // below, instead of rendering the raw key verbatim to an Arabic merchant.
  const fieldError = (name: keyof NonNullable<typeof fields>) => {
    const raw = fields?.[name]?.[0];
    if (raw === undefined) return undefined;
    return labels.errors[raw] ?? raw;
  };
  const errorMessage = state?.error
    ? (labels.errors[state.error] ?? labels.errors["errors.generic"])
    : undefined;
  // The banner is suppressed only when the user can actually SEE the problem
  // somewhere else. `fields` alone is not that test: `flatten().fieldErrors`
  // is `{}` for an object-level issue and `{locale: [...]}` for a bad locale
  // — both truthy, and neither renders anywhere, since `locale` is a hidden
  // input with no FormField. Keying off `!fields` therefore hid the only
  // feedback there was, leaving a form that visibly does nothing on submit.
  const RENDERED_FIELDS = ["fullName", "companyName", "email", "password"] as const;
  const hasVisibleFieldError = RENDERED_FIELDS.some((name) => fieldError(name) !== undefined);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />
      <FormField label={labels.fullName} required error={fieldError("fullName")}>
        <input type="text" name="fullName" required minLength={2} autoComplete="name" className={inputClass} />
      </FormField>
      <FormField label={labels.companyName} required error={fieldError("companyName")}>
        <input type="text" name="companyName" required minLength={2} autoComplete="organization" className={inputClass} />
      </FormField>
      <FormField label={labels.email} required error={fieldError("email")}>
        <input type="email" name="email" required autoComplete="email" className={inputClass} />
      </FormField>
      <FormField label={labels.password} required error={fieldError("password")}>
        <input
          type="password"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </FormField>
      {errorMessage && !hasVisibleFieldError ? (
        <p className="text-sm text-danger">{errorMessage}</p>
      ) : null}
      <SubmitButton>{labels.submit}</SubmitButton>
    </form>
  );
}

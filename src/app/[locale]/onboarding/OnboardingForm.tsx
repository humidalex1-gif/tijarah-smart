"use client";

import { useActionState } from "react";
import { onboardingAction } from "./actions";
import { FormField, inputClass } from "@/components/ui/FormField";
import { SubmitButton } from "@/components/ui/SubmitButton";

export function OnboardingForm({
  locale,
  defaults,
  labels,
}: {
  locale: string;
  defaults: {
    companyName: string;
    currencyCode: string;
    taxRatePct: number;
    warehouseName: string;
  };
  labels: {
    title: string;
    companyStep: string;
    financeStep: string;
    warehouseStep: string;
    companyName: string;
    currency: string;
    taxRate: string;
    warehouseName: string;
    openingCash: string;
    openingBank: string;
    submit: string;
    // Keyed by the translation key onboardingAction returns in `error`
    // (e.g. "errors.FORBIDDEN", "errors.ONBOARDING_ALREADY_COMPLETED") or in
    // a `fields[...]` entry (e.g. "errors.INVALID_NAME"), pre-translated
    // server-side — same pattern as RegisterForm.tsx.
    errors: Record<string, string>;
  };
}) {
  const [state, formAction] = useActionState(onboardingAction, null);
  const fields = state && "fields" in state ? state.fields : undefined;
  // A field's raw message is a dictionary KEY, not display text — resolved
  // through `labels.errors` before it reaches the screen, same as
  // `errorMessage` below, instead of rendering the raw key verbatim to an
  // Arabic merchant.
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
  const RENDERED_FIELDS = ["companyName", "currencyCode", "taxRate", "warehouseName", "openingCash", "openingBank"] as const;
  const hasVisibleFieldError = RENDERED_FIELDS.some((name) => fieldError(name) !== undefined);

  return (
    <form action={formAction} className="space-y-8">
      <input type="hidden" name="locale" value={locale} />

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.companyStep}</legend>
        <FormField label={labels.companyName} required error={fieldError("companyName")}>
          <input
            type="text"
            name="companyName"
            required
            minLength={2}
            defaultValue={defaults.companyName}
            className={inputClass}
          />
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.financeStep}</legend>
        <FormField label={labels.currency} required error={fieldError("currencyCode")}>
          <input
            type="text"
            name="currencyCode"
            required
            minLength={3}
            maxLength={3}
            defaultValue={defaults.currencyCode}
            className={`${inputClass} uppercase`}
          />
        </FormField>
        <FormField label={labels.taxRate} required error={fieldError("taxRate")}>
          <input
            type="number"
            name="taxRate"
            required
            min={0}
            max={100}
            step="0.01"
            defaultValue={defaults.taxRatePct / 100}
            className={inputClass}
          />
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-navy">{labels.warehouseStep}</legend>
        <FormField label={labels.warehouseName} required error={fieldError("warehouseName")}>
          <input
            type="text"
            name="warehouseName"
            required
            minLength={1}
            defaultValue={defaults.warehouseName}
            className={inputClass}
          />
        </FormField>
        <FormField label={labels.openingCash} error={fieldError("openingCash")}>
          <input type="number" name="openingCash" min={0} step="0.01" className={inputClass} />
        </FormField>
        <FormField label={labels.openingBank} error={fieldError("openingBank")}>
          <input type="number" name="openingBank" min={0} step="0.01" className={inputClass} />
        </FormField>
      </fieldset>

      {errorMessage && !hasVisibleFieldError ? <p className="text-sm text-danger">{errorMessage}</p> : null}
      <SubmitButton>{labels.submit}</SubmitButton>
    </form>
  );
}

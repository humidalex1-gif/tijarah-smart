import type { ReactNode } from "react";

export function FormField({
  label, error, hint, required, children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {label}
        {required ? <span className="ms-1 text-danger">*</span> : null}
      </span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs leading-relaxed text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs leading-relaxed text-danger">{error}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

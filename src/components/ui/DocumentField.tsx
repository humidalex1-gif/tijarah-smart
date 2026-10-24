"use client";

import { useRef, useState } from "react";

/**
 * A file picker for a record that is being created.
 *
 * It holds the chosen `File` and hands it back, rather than uploading on
 * selection. Uploading early would leave a document in storage every time
 * somebody opened a form, picked a file and then changed their mind — the
 * upload happens with the save, in one request, or not at all.
 */
export function DocumentField({
  label, hint, clearLabel, onChange, disabled = false,
}: {
  label: string;
  hint: string;
  clearLabel: string;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);

  return (
    <div>
      <label className="block text-sm font-medium" htmlFor="document-field">{label}</label>
      <p className="mt-1 text-xs text-muted">{hint}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          id="document-field"
          ref={ref}
          type="file"
          accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png,.webp"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            setName(file?.name ?? null);
            onChange(file);
          }}
          className="block w-full max-w-md text-sm file:me-3 file:rounded-lg file:border-0
            file:bg-subtle file:px-4 file:py-2 file:text-sm file:font-medium"
        />
        {name ? (
          <button
            type="button"
            onClick={() => {
              if (ref.current) ref.current.value = "";
              setName(null);
              onChange(null);
            }}
            disabled={disabled}
            className="text-sm text-muted hover:text-danger disabled:opacity-50"
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

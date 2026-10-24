"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The document behind an expense.
 *
 * An expense without its invoice is a number somebody typed. Keeping the
 * source next to it is what makes it checkable a year later, when nobody
 * remembers what "شحن" for 220 was.
 */

type Attachment = { id: string; fileName: string; mimeType: string; sizeBytes: number };

type Labels = Record<
  "add" | "adding" | "hint" | "none" | "remove" | "removing" | "open" | "generic",
  string
>;

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function Attachments({
  expenseId, locale, initial, labels,
}: {
  expenseId: string;
  locale: string;
  initial: Attachment[];
  labels: Labels;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setBusy("add"); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("expenseId", expenseId);
      const { attachToExpenseAction } = await import("./actions");
      const result = await attachToExpenseAction(fd);
      if (result.ok) {
        setItems((current) => [result.data, ...current]);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError(labels.generic);
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(id: string) {
    setBusy(id); setError(null);
    try {
      const fd = new FormData();
      fd.append("attachmentId", id);
      const { removeExpenseAttachmentAction } = await import("./actions");
      const result = await removeExpenseAttachmentAction(fd);
      if (result.ok) {
        setItems((current) => current.filter((a) => a.id !== id));
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError(labels.generic);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted">{labels.none}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3">
              <a
                href={`/${locale}/attachments/${item.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-brand hover:underline"
              >
                {item.fileName}
              </a>
              <span className="flex items-center gap-3">
                <span className="text-xs text-muted">{kb(item.sizeBytes)}</span>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  disabled={busy !== null}
                  className="text-sm text-muted hover:text-danger disabled:opacity-50"
                >
                  {busy === item.id ? labels.removing : labels.remove}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div>
        <label className="block text-sm font-medium" htmlFor={`file-${expenseId}`}>{labels.add}</label>
        <p className="mt-1 text-xs text-muted">{labels.hint}</p>
        <input
          id={`file-${expenseId}`}
          ref={fileRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png,.webp"
          disabled={busy !== null}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
          className="mt-2 block w-full text-sm file:me-3 file:rounded-lg file:border-0 file:bg-subtle
            file:px-4 file:py-2 file:text-sm file:font-medium"
        />
        {busy === "add" ? <p className="mt-2 text-sm text-muted">{labels.adding}</p> : null}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

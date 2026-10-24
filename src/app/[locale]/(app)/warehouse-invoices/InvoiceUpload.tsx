"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { formatMoney, formatNumber } from "@/lib/format";
import { FormField, inputClass } from "@/components/ui/FormField";
import {
  classifyInvoiceFiles,
  type InvoiceFileProblem,
} from "@/services/warehouseInvoice/invoiceFiles";

/**
 * Read the file, show what it says, then post it — never in one motion.
 *
 * The whole screen exists so the owner sees the warehouse's own arithmetic
 * re-derived before any of it touches an order's profit. Auto-posting on
 * upload would make every check below decoration.
 */

type Issue = { kind: string; ref?: string; stated?: number; computed?: number; charged?: number; expected?: number };

type Preview = {
  attachmentId: string;
  fileName: string;
  documentAttachmentId: string | null;
  documentFileName: string | null;
  suggestedInvoiceNumber: string | null;
  invoiceDate: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  totals: { orderFees: number; storage: number };
  issues: Issue[];
  unbilled: { salesOrderNumber: string; externalRef: string }[];
  orders: {
    ref: string; salesOrderNumber: string | null; matched: boolean;
    packagingFee: number; handlingFee: number; shippingFee: number;
    extraPieceFee: number; total: number;
  }[];
  storage: { description: string; quantity: number; amount: number }[];
};

type Labels = Record<
  | "upload" | "uploadHint" | "reading" | "post" | "posting" | "posted"
  | "invoiceNumber" | "invoiceNumberHint" | "category" | "account"
  | "orderFees" | "storage" | "subtotal" | "tax" | "total"
  | "order" | "matched" | "notMatched" | "issues" | "noIssues" | "unbilled"
  | "packaging" | "handling" | "shipping" | "extraPieces" | "generic",
  string
>;

const money = (minor: number, locale: Locale, currency: string) => formatMoney(minor, locale, currency);

export function InvoiceUpload({
  locale, currency, labels, categories, accounts, issueLabels, problemLabels,
}: {
  locale: Locale;
  currency: string;
  labels: Labels;
  categories: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  issueLabels: Record<string, string>;
  problemLabels: Record<InvoiceFileProblem, string>;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onFiles(chosen: File[]) {
    setBusy(true); setError(null); setDone(null); setPreview(null);
    try {
      // Both of Fast Hub's files may be dropped in at once; which is which is
      // decided here rather than by asking the owner to load two inputs in the
      // right order. Anything ambiguous is refused by name, not guessed at.
      const { workbook, document, problem } = classifyInvoiceFiles(chosen);
      if (!workbook) {
        setError(problemLabels[problem ?? "NO_WORKBOOK"] ?? labels.generic);
        return;
      }

      const fd = new FormData();
      fd.append("file", workbook);
      if (document) fd.append("document", document);
      const { previewWarehouseInvoiceAction } = await import("./actions");
      const result = await previewWarehouseInvoiceAction(fd);
      if (result.ok) {
        const data = result.data as unknown as Preview;
        setPreview(data);
        // The PDF's filename announces the number; its text layer cannot be
        // read. With no PDF, or a name that names no number, fall back to the
        // date so the field is never blank — the owner corrects either way.
        setInvoiceNumber(data.suggestedInvoiceNumber ?? String(data.invoiceDate).slice(0, 10));
        // A file that could not be placed is reported even though the parse
        // succeeded: silence would look like it had been taken into account.
        if (problem === "UNSUPPORTED_FILE") setError(problemLabels.UNSUPPORTED_FILE);
      } else {
        // Never the raw key: result.error is a dictionary key ("errors.X"),
        // and rendering it verbatim showed an Arabic merchant the literal
        // string "errors.FORBIDDEN" (rule 8). Unmapped errors read generic.
        setError(problemLabels[result.error as keyof typeof problemLabels] ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      setBusy(false);
    }
  }

  async function onPost() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("attachmentId", preview.attachmentId);
      if (preview.documentAttachmentId) {
        fd.append("documentAttachmentId", preview.documentAttachmentId);
      }
      fd.append("invoiceNumber", invoiceNumber);
      fd.append("expenseCategoryId", categoryId);
      fd.append("expenseAccountId", accountId);
      const { postWarehouseInvoiceAction } = await import("./actions");
      const result = await postWarehouseInvoiceAction(fd);
      if (result.ok) {
        setDone(
          `${labels.posted} — ${formatNumber(result.data.ordersCharged, locale)} · `
          + `${money(result.data.orderFeesPosted, locale, currency)} + ${money(result.data.storagePosted, locale, currency)}`,
        );
        setPreview(null);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } else {
        // Never the raw key: result.error is a dictionary key ("errors.X"),
        // and rendering it verbatim showed an Arabic merchant the literal
        // string "errors.FORBIDDEN" (rule 8). Unmapped errors read generic.
        setError(problemLabels[result.error as keyof typeof problemLabels] ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-panel p-4">
        <label className="block text-sm font-medium" htmlFor="invoice-file">{labels.upload}</label>
        <p className="mt-1 text-xs text-muted">{labels.uploadHint}</p>
        <input
          id="invoice-file"
          ref={fileRef}
          type="file"
          multiple
          accept=".xlsx,.xls,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            if (chosen.length > 0) void onFiles(chosen);
          }}
          className="mt-3 block w-full text-sm file:me-3 file:rounded-lg file:border-0 file:bg-brand
            file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-ink"
        />
        {busy && !preview ? <p className="mt-2 text-sm text-muted">{labels.reading}</p> : null}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
        {done ? <p className="mt-2 text-sm text-success">{done}</p> : null}
      </div>

      {preview ? (
        <div className="space-y-4 rounded-xl border border-line bg-panel p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span className="text-muted">{preview.fileName}</span>
            {preview.documentFileName
              ? <span className="text-muted">{preview.documentFileName}</span>
              : null}
            <span>{labels.orderFees}: <b className="tabular-nums">{money(preview.totals.orderFees, locale, currency)}</b></span>
            <span>{labels.storage}: <b className="tabular-nums">{money(preview.totals.storage, locale, currency)}</b></span>
            <span>{labels.subtotal}: <b className="tabular-nums">{money(preview.subtotal, locale, currency)}</b></span>
            <span>{labels.tax}: <b className="tabular-nums">{money(preview.taxAmount, locale, currency)}</b></span>
            <span>{labels.total}: <b className="tabular-nums">{money(preview.total, locale, currency)}</b></span>
          </div>

          {/* Findings first. They are the reason to look at this screen at
              all, and burying them under the table would make the table the
              point instead of the check. */}
          {preview.issues.length > 0 ? (
            <div className="rounded-lg border border-warning bg-warning-soft p-3">
              <p className="text-sm font-semibold text-navy">{labels.issues}</p>
              <ul className="mt-1 space-y-1">
                {preview.issues.map((issue, i) => (
                  <li key={`${issue.kind}-${issue.ref ?? i}`} className="text-sm text-navy">
                    {issueLabels[issue.kind] ?? issue.kind}
                    {issue.ref ? `: ${issue.ref}` : ""}
                    {issue.charged !== undefined && issue.expected !== undefined
                      ? ` (${formatNumber(issue.charged, locale)} ← ${formatNumber(issue.expected, locale)})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="rounded-lg border border-success bg-success-soft p-3 text-sm text-navy">
              {labels.noIssues}
            </p>
          )}

          {preview.unbilled.length > 0 ? (
            <p className="text-sm text-muted">
              {labels.unbilled}: {preview.unbilled.map((o) => o.salesOrderNumber).join("، ")}
            </p>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th className="py-2 text-start">{labels.order}</th>
                  <th className="py-2 text-end">{labels.packaging}</th>
                  <th className="py-2 text-end">{labels.handling}</th>
                  <th className="py-2 text-end">{labels.shipping}</th>
                  <th className="py-2 text-end">{labels.extraPieces}</th>
                  <th className="py-2 text-end">{labels.total}</th>
                </tr>
              </thead>
              <tbody>
                {preview.orders.map((o) => (
                  <tr key={o.ref} className="border-b border-hairline">
                    <td className="py-2">
                      <span className="font-mono text-xs">{o.ref}</span>{" "}
                      {o.matched
                        ? <span className="text-xs text-success">{o.salesOrderNumber}</span>
                        : <span className="text-xs text-danger">{labels.notMatched}</span>}
                    </td>
                    <td className="py-2 text-end tabular-nums">{money(o.packagingFee, locale, currency)}</td>
                    <td className="py-2 text-end tabular-nums">{money(o.handlingFee, locale, currency)}</td>
                    <td className="py-2 text-end tabular-nums">{money(o.shippingFee, locale, currency)}</td>
                    <td className="py-2 text-end tabular-nums">{money(o.extraPieceFee, locale, currency)}</td>
                    <td className="py-2 text-end font-semibold tabular-nums">{money(o.total, locale, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label={labels.invoiceNumber} hint={labels.invoiceNumberHint}>
              <input
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label={labels.category}>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className={inputClass}
              >
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FormField>
            <FormField label={labels.account}>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={inputClass}
              >
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
          </div>

          <button
            type="button"
            onClick={onPost}
            disabled={busy || !invoiceNumber || !categoryId || !accountId}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-50"
          >
            {busy ? labels.posting : labels.post}
          </button>
        </div>
      ) : null}
    </div>
  );
}

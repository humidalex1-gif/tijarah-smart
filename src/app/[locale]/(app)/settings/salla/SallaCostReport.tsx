"use client";

import { useState } from "react";
import { readSallaCostsAction } from "./actions";
import { fillTemplate, type Locale } from "@/lib/i18n";
import { formatMoney, formatNumber } from "@/lib/format";
import { fromCost } from "@/lib/money";
import type { CostComparison, CostStatus } from "@/services/salla/costCompare";
import { DataTable, type Column } from "@/components/ui/DataTable";

/**
 * Answers, on screen, the question open since 2026-08-06: does Salla hold a
 * cost for the products booked at zero, which put 45.4% of revenue on the
 * books at 100% margin?
 *
 * Three properties this must keep:
 *
 *  - It reads only when ASKED. The read spends a Salla API call and needs a
 *    live authorisation; firing on page load would burn both on every visit.
 *  - A failed read and an empty result are shown as DIFFERENT things. Telling
 *    the owner "Salla holds nothing" when the connection is broken sends them
 *    hunting for numbers that are sitting right there.
 *  - It hands over the exact repair command with the figures already in it.
 *    `fix-product-costs.ts` has no undo and takes SAR on the command line;
 *    copying figures off a table by hand is where a digit gets dropped.
 */

export interface SallaCostReportLabels {
  title: string; intro: string; read: string; reading: string;
  sku: string; ourCost: string; theirCost: string; state: string;
  repairableTitle: string; commandHint: string; noneTitle: string;
  summaryTemplate: string;
  status: Record<CostStatus, string>;
  errors: Record<string, string>;
}

export function SallaCostReport({
  locale, currency, labels,
}: {
  locale: Locale;
  currency: string;
  labels: SallaCostReportLabels;
}) {
  const [report, setReport] = useState<CostComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  async function read() {
    setReading(true);
    setError(null);
    setReport(null);
    try {
      const res = await readSallaCostsAction(new FormData());
      if (res.ok) setReport(res.data as CostComparison);
      else setError(labels.errors[res.error] ?? labels.errors["errors.generic"]!);
    } catch (e) {
      console.error("Salla cost read failed:", e);
      setError(labels.errors["errors.generic"]!);
    } finally {
      setReading(false);
    }
  }

  // Dry run: no `--apply`. Committing the figures is the owner's deliberate
  // second step, after reading what the script says it would write.
  const command = report && report.repairable.length > 0
    ? `node --env-file=.env --import tsx scripts/fix-product-costs.ts ${
      report.repairable.map((r) => `${r.sku}=${r.sallaCostSar}`).join(" ")
    }`
    : null;

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-lg font-semibold text-navy">{labels.title}</h2>
      <p className="mt-1 text-sm text-muted">{labels.intro}</p>

      <button
        type="button"
        onClick={read}
        disabled={reading}
        className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {reading ? labels.reading : labels.read}
      </button>

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      {report ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            {fillTemplate(labels.summaryTemplate, {
              salla: formatNumber(report.summary.sallaProducts, locale),
              matched: formatNumber(report.summary.matched, locale),
              repairable: formatNumber(report.summary.repairable, locale),
            })}
          </p>

          {report.repairable.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-navy">{labels.repairableTitle}</h3>
              <p className="mt-2 text-xs text-muted">{labels.commandHint}</p>
              <pre
                data-testid="salla-cost-command"
                className="mt-1 overflow-x-auto rounded-lg border border-line bg-surface p-3 text-xs"
                dir="ltr"
              >
                {command}
              </pre>
            </div>
          ) : (
            <p className="text-sm font-medium text-navy">{labels.noneTitle}</p>
          )}

          <DataTable
            columns={[
              { key: "sku", header: labels.sku, render: (r) => <span dir="ltr">{r.sku}</span> },
              { key: "ours", header: labels.ourCost, align: "end", render: (r) => <span className="tabular-nums">{formatMoney(fromCost(r.ourAvgCost), locale, currency)}</span> },
              { key: "theirs", header: labels.theirCost, align: "end", render: (r) => <span className="tabular-nums">{r.sallaCostMinor === null ? "—" : formatMoney(r.sallaCostMinor, locale, currency)}</span> },
              { key: "state", header: labels.state, render: (r) => labels.status[r.status] },
            ] satisfies Column<CostComparison["rows"][number] & { id: string }>[]}
            rows={report.rows.map((r) => ({ ...r, id: r.sku }))}
            empty={null}
          />
        </div>
      ) : null}
    </section>
  );
}

import Link from "next/link";
import { formatNumber } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

/**
 * The "awaiting you" card: everything pending, in one place, each row a link
 * to the screen that resolves it.
 *
 * Rows arrive already counted and already permission-filtered — this renders
 * and decides nothing. It disappears entirely when nothing is pending: an
 * empty "awaiting you" card is a daily invitation to stop reading it.
 */
export interface PendingRow {
  key: string;
  count: number;
  label: string;
  href: string;
}

export function PendingActions({
  title, rows, locale,
}: {
  title: string;
  rows: PendingRow[];
  locale: Locale;
}) {
  const visible = rows.filter((row) => row.count > 0);
  if (visible.length === 0) return null;

  return (
    <section className="mb-6 rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold text-navy">{title}</h2>
      <ul className="mt-3 divide-y divide-line">
        {visible.map((row) => (
          <li key={row.key}>
            <Link
              href={row.href}
              className="flex items-center justify-between gap-4 py-2.5 text-sm text-navy hover:text-brand"
            >
              <span>{row.label}</span>
              <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-2 text-xs font-bold tabular-nums text-brand-ink">
                {formatNumber(row.count, locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

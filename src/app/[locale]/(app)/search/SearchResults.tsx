import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/lib/i18n";
import type { SearchResult } from "@/services/search";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Presentational only: sections arrive already permission-filtered by the
 * page (a null section was not allowed, an empty one found nothing), so this
 * file decides rendering and nothing else.
 */
export interface SearchLabels {
  productsTitle: string;
  ordersTitle: string;
  noResults: string;
  sku: string;
  /** Translated per status code, for whichever statuses the results carry. */
  status: Record<string, string>;
}

export function SearchResults({
  locale, currency, query, products, orders, labels,
}: {
  locale: Locale;
  currency: string;
  query: string;
  products: SearchResult["products"] | null;
  orders: SearchResult["orders"] | null;
  labels: SearchLabels;
}) {
  if (query.trim() === "") return null;

  const empty = (products?.length ?? 0) === 0 && (orders?.length ?? 0) === 0;
  if (empty) {
    return <div className="mt-6"><EmptyState message={labels.noResults} /></div>;
  }

  return (
    <div className="mt-6 space-y-8">
      {products && products.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-navy">{labels.productsTitle}</h2>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-panel">
            {products.map((p) => (
              <li key={p.id}>
                <Link href={`/${locale}/products/${p.id}`} className="flex items-center justify-between gap-4 p-3 text-sm hover:text-brand">
                  {/* The status is on every row, not only the exception: a
                      badge that appears only for ARCHIVED would make "no
                      badge" mean "active", which nobody is told. */}
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-navy">{locale === "ar" ? p.nameAr : p.nameEn}</span>
                    <StatusBadge
                      label={labels.status[p.status] ?? p.status}
                      tone={p.status === "ACTIVE" ? "success" : "neutral"}
                    />
                  </span>
                  <span dir="ltr" className="shrink-0 text-xs text-muted">{p.sku}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {orders && orders.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-navy">{labels.ordersTitle}</h2>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-panel">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={`/${locale}/sales/${o.id}`} className="flex items-center justify-between gap-4 p-3 text-sm hover:text-brand">
                  <span className="min-w-0">
                    <span dir="ltr" className="block text-navy">{o.salesOrderNumber}</span>
                    {/* Two orders with similar numbers could only be told
                        apart by opening both; the date was already fetched. */}
                    <span className="block text-xs text-muted">{formatDate(o.orderDate, locale)}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {formatMoney(o.grandTotal, locale, currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

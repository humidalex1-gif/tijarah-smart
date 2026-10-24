import Link from "next/link";

/**
 * Page-based pagination for a server-rendered list page. Deliberately plain
 * `<Link>`s (not client-side state) — the page itself already re-fetches on
 * every filter change via searchParams, so paging follows the same pattern
 * rather than introducing a second one.
 */
export function Pagination({
  page, pageSize, total, buildHref, labels,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
  labels: { previous: string; next: string; pageInfo: string };
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    <div className="mt-4 flex items-center justify-between">
      <Link
        href={buildHref(Math.max(1, page - 1))}
        aria-disabled={atFirst}
        tabIndex={atFirst ? -1 : undefined}
        className={`rounded-lg border border-line px-3 py-1.5 text-sm ${
          atFirst ? "pointer-events-none opacity-40" : "hover:bg-surface"
        }`}
      >
        {labels.previous}
      </Link>
      <span className="text-sm text-muted">{labels.pageInfo}</span>
      <Link
        href={buildHref(Math.min(totalPages, page + 1))}
        aria-disabled={atLast}
        tabIndex={atLast ? -1 : undefined}
        className={`rounded-lg border border-line px-3 py-1.5 text-sm ${
          atLast ? "pointer-events-none opacity-40" : "hover:bg-surface"
        }`}
      >
        {labels.next}
      </Link>
    </div>
  );
}

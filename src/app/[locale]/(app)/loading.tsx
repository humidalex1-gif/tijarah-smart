/**
 * Route-level Suspense fallback for the whole (app) segment — Next shows
 * this while a page (or a page's data fetch) under this layout is still
 * resolving, e.g. a slow dashboard aggregate query or a hard navigation
 * into any (app) screen. No page under this group has its own `loading.tsx`
 * yet, so this one shape has to read as a plausible placeholder for all of
 * them: every (app) page renders a KPI/filter row on top of a table or a
 * form, so this approximates that common shape rather than any one page's
 * exact layout.
 *
 * No translated text — a skeleton has nothing to say, so this stays a
 * locale-agnostic Server Component with zero i18n surface. `animate-pulse`
 * is plain Tailwind (no client JS needed) and the layout uses only logical
 * spacing (`gap`, `grid`) so it mirrors correctly under `dir="rtl"`.
 */
function Block({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface ${className}`} />;
}

export default function AppLoading() {
  return (
    <div>
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Block key={i} className="h-8 w-24" />
        ))}
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-line bg-panel p-4">
            <Block className="h-3 w-20" />
            <Block className="mt-3 h-6 w-24" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="border-b border-line bg-surface p-3">
          <Block className="h-4 w-32" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line p-4 last:border-0">
            <Block className="h-4 flex-1" />
            <Block className="h-4 w-20" />
            <Block className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

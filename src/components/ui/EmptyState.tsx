import Link from "next/link";

export function EmptyState({
  message, actionLabel, actionHref,
}: {
  message: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel p-10 text-center">
      <p className="text-sm leading-relaxed text-muted">{message}</p>
      {actionLabel && actionHref ? (
        <Link
          href={actionHref}
          className="mt-4 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

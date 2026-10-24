import Link from "next/link";
import type { ReactNode } from "react";

export function KpiCard({
  label, value, sub, tone = "neutral", href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
  href?: string;
}) {
  const toneClass = {
    neutral: "text-navy",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];

  const card = (
    <div className="rounded-xl border border-line bg-panel p-4 transition hover:shadow-sm">
      <div className="text-xs font-medium text-muted">{label}</div>
      {/* One step down on a phone: at two cards per row a long formatted-money
          string wraps inside a half-width card at 2xl. */}
      <div className={`mt-2 text-xl font-semibold sm:text-2xl ${toneClass}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs leading-relaxed text-muted">{sub}</div> : null}
    </div>
  );

  return href ? <Link href={href}>{card}</Link> : card;
}

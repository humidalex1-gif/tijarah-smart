"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import { activeNavKey } from "@/lib/nav";

/**
 * The phone's bottom bar: the four screens the owner lives in, one tap each.
 *
 * Below `md` the sidebar is an off-canvas drawer, which prices every
 * navigation at two taps (open, then choose). Installed to a home screen the
 * app should feel like an app, and apps put their primary destinations on a
 * bottom bar.
 *
 * Items arrive from the layout ALREADY permission-filtered and labelled —
 * the same contract Sidebar has — so a role that cannot open a screen never
 * sees its tab. The active tab tracks the LIVE pathname for the same reason
 * Sidebar does: a layout renders once per hard load, and a highlight computed
 * server-side froze on client navigation (the bug the owner caught on the
 * sidebar in August).
 *
 * Fewer than two visible items renders nothing: a bar with one destination
 * is chrome without navigation.
 */

/** Stroke icons in the app's own line style, one per primary destination. */
const ICONS: Record<string, ReactNode> = {
  quick: <><path d="M12 5v14M5 12h14" /></>,
  dashboard: <><rect x="4" y="4" width="7" height="9" rx="1" /><rect x="13" y="4" width="7" height="5" rx="1" /><rect x="13" y="11" width="7" height="9" rx="1" /><rect x="4" y="15" width="7" height="5" rx="1" /></>,
  sales: <><path d="M4 19V5" /><path d="M4 15l4-4 4 3 8-8" /><path d="M16 6h4v4" /></>,
  expenses: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" /><path d="M9 9h6M9 13h4" /></>,
};

export function BottomNav({
  locale, items,
}: {
  locale: Locale;
  items: { key: string; href: string; label: string }[];
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname ?? `/${locale}`, locale);

  if (items.length < 2) return null;

  return (
    <nav
      aria-label="primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        {items.map((item) => {
          const isActive = active === item.key;
          return (
            <li key={item.key} className="min-w-0 flex-1">
              <Link
                href={`/${locale}/${item.href}`}
                aria-current={isActive ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 px-1 py-2 text-[0.6875rem] ${
                  isActive ? "font-semibold text-brand" : "text-muted"
                }`}
              >
                <svg
                  viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                >
                  {ICONS[item.key]}
                </svg>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

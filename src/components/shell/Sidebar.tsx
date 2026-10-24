"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { activeNavKey } from "@/lib/nav";

/**
 * A client component so the active highlight tracks the LIVE pathname.
 * It was server-rendered with an `active` prop computed per request — but
 * layouts do not re-render on client-side navigation, so the highlight froze
 * on whichever page was last hard-loaded. Items arrive already filtered by
 * permission and already labelled; no translator crosses the boundary.
 */
export function Sidebar({
  locale, appName, items,
}: {
  locale: Locale;
  appName: string;
  items: { key: string; href: string; label: string }[];
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname ?? `/${locale}`, locale);

  return (
    // Below `md` (768px) this is an off-canvas drawer, closed by default:
    // fixed and pushed fully past the inline-start edge via a NEGATIVE
    // logical `start` offset (`start-[-15rem]`, i.e. -w-60), toggled open
    // by Header's hamburger via the peer checkbox `AppLayout` renders right
    // before this component (`#mobile-nav-toggle` — `peer-checked:start-0`).
    // `inset-inline-start` flips physical side under `dir="rtl"` on its
    // own — deliberately NOT `-translate-x-full` + an `rtl:` variant
    // override: that combination measurably lost the cascade to
    // `peer-checked:` here (`--tw-translate-x` resolved correctly per
    // devtools, but the `translate` shorthand it feeds did not — a real,
    // reproduced browser quirk, not a hunch), where two plain physical
    // `inset-inline-start` values need no variant stacking to begin with.
    // At `md` and above it reverts to a normal static flex sibling, always
    // visible, exactly like before this became responsive.
    <nav
      className="fixed inset-y-0 start-[-15rem] z-40 w-60 shrink-0 overflow-y-auto border-e border-line
        bg-panel p-4 transition-[inset-inline-start] duration-200 ease-in-out peer-checked:start-0
        md:static md:z-auto md:start-auto print:hidden"
    >
      <div className="mb-6 px-2 text-lg font-semibold">{appName}</div>
      <ul className="space-y-1">
        {items.map((item) => {
          const href = `/${locale}${item.href ? `/${item.href}` : ""}`;
          const isActive = active === item.key;
          return (
            <li key={item.key}>
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? "bg-brand text-brand-ink"
                    : "text-navy hover:bg-surface"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

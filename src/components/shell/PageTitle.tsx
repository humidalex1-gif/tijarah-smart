"use client";

import { usePathname } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { activeNavKey } from "@/lib/nav";

/**
 * The header's page title, resolved from the LIVE pathname on the client.
 *
 * It was a string computed by the server layout from the request's
 * x-pathname header — but layouts do not re-render on client-side
 * navigation, so the title froze on whichever page was last hard-loaded
 * while the content underneath changed. All titles for the nav sections
 * arrive precomputed; this component only picks one.
 */
export function PageTitle({ locale, titles }: { locale: Locale; titles: Record<string, string> }) {
  const pathname = usePathname();
  const active = activeNavKey(pathname ?? `/${locale}`, locale);

  // `truncate` + the parent's `min-w-0` let a long title ellipsize instead
  // of forcing the header's action group into horizontal overflow.
  return <h1 className="truncate text-xl font-semibold">{titles[active] ?? ""}</h1>;
}

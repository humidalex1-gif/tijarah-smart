"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

// Hardcoded rather than routed through `getTranslator`/`getDictionary` (both
// async) for the same reason as this group's `error.tsx`: `params` is NOT
// reliably resolved for a nested `not-found.tsx` when it's reached via the
// imperative `notFound()` call every `[id]/page.tsx` under this group uses
// on a missing record (confirmed empirically — a Server Component version
// reading `params` here throws "Cannot destructure property 'locale' ...
// as it is undefined" the moment `notFound()` fires deeper in the tree, even
// though `params` typechecks as present). `usePathname()` on a Client
// Component reads the real URL instead of depending on that resolution.
const STRINGS: Record<Locale, { message: string; back: string }> = {
  en: { message: "Page not found.", back: "Back to dashboard" },
  ar: { message: "الصفحة غير موجودة.", back: "العودة إلى لوحة التحكم" },
};

function localeFromPathname(pathname: string | null): Locale {
  const segment = pathname?.split("/")[1];
  return segment && (LOCALES as readonly string[]).includes(segment)
    ? (segment as Locale)
    : DEFAULT_LOCALE;
}

/**
 * Backstop for any unmatched segment under the authenticated (app) area
 * (e.g. `/products/does-not-exist`) or a `notFound()` call from a
 * `[id]/page.tsx` on a missing record — distinct from the root
 * `[locale]/not-found.tsx`, which only catches an unmatched locale segment
 * itself.
 */
export default function AppNotFound() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = STRINGS[locale];

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-lg font-medium text-navy">{strings.message}</p>
      <Link
        href={`/${locale}/dashboard`}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink transition hover:opacity-90"
      >
        {strings.back}
      </Link>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

// Hardcoded rather than routed through `getTranslator`/`getDictionary`
// (both async): per Next's error-boundary contract this file must be a
// Client Component, and React does not support an async render for Client
// Components (only Server Components may `await` in the component body), so
// this boundary cannot await the dictionary loader the rest of the app
// uses. Hardcoding also means this backstop still renders correctly even if
// the failure that triggered it was itself somewhere in the
// translation/dictionary-loading path. `LanguageSwitcher` (a Client
// Component too) already hardcodes its locale-specific strings the same way
// for the same reason.
const STRINGS: Record<Locale, { message: string; back: string; retry: string }> = {
  en: {
    message: "Something went wrong. Please try again.",
    back: "Back to dashboard",
    retry: "Try again",
  },
  ar: {
    message: "حدث خطأ ما. يرجى المحاولة مرة أخرى.",
    back: "العودة إلى لوحة التحكم",
    retry: "إعادة المحاولة",
  },
};

function localeFromPathname(pathname: string | null): Locale {
  const segment = pathname?.split("/")[1];
  return segment && (LOCALES as readonly string[]).includes(segment)
    ? (segment as Locale)
    : DEFAULT_LOCALE;
}

/**
 * Backstop for the authenticated (app) area (Task 4 review, Fix 1): any
 * error thrown inside `(app)/page.tsx` or a sibling route under this group
 * — including a `ServiceError("FORBIDDEN")` from a page that still calls
 * `assertCan` directly instead of `requirePermission` (see
 * `src/lib/appContext.ts`) — lands here instead of Next's default 500 page.
 *
 * Deliberately does not read or render `error.message` / `error.stack`:
 * either can carry internal detail (a permission name, a record id, a raw
 * Prisma message) that must not reach the page.
 *
 * Per Next's error.js contract this file MUST be a Client Component, and it
 * does NOT catch errors thrown by `(app)/layout.tsx` itself — only by the
 * page/segments it wraps — since the boundary this file defines is nested
 * inside that layout's own component.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  void error; // intentionally unread — see doc comment above
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = STRINGS[locale];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-lg font-medium text-navy">{strings.message}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium text-navy transition hover:bg-surface"
        >
          {strings.retry}
        </button>
        <Link
          href={`/${locale}/dashboard`}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink transition hover:opacity-90"
        >
          {strings.back}
        </Link>
      </div>
    </div>
  );
}

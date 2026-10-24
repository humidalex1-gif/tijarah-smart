"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LOCALES, type Locale } from "@/lib/i18n";

export function LanguageSwitcher({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  // usePathname() excludes the query string, so building the target from it
  // alone used to drop every filter and the current page position (e.g.
  // `/en/sales?status=CONFIRMED&from=...&page=3` became `/ar/sales`) — a
  // frequently-used control in a bilingual product. Preserve it explicitly.
  const searchParams = useSearchParams();
  const router = useRouter();

  function switchTo(next: Locale) {
    const rest = pathname.replace(new RegExp(`^/(${LOCALES.join("|")})`), "");
    const qs = searchParams.toString();
    router.push(`/${next}${rest}${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex gap-1 rounded-lg border border-line p-0.5">
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => switchTo(option)}
          // The selected chip wears the accent, the same trio the app's other
          // four tab strips use. It was `bg-navy`, which is the theme
          // foreground — in dark mode that made this the brightest object on
          // the screen, brighter than any figure. The unselected border is
          // transparent rather than absent so both chips stay the same size.
          className={`rounded-md border px-2 py-1 text-xs font-medium ${
            option === locale
              ? "border-brand bg-brand text-brand-ink"
              : "border-transparent text-muted hover:bg-surface"
          }`}
        >
          {option === "ar" ? "العربية" : "English"}
        </button>
      ))}
    </div>
  );
}

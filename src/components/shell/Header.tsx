import type { ReactNode } from "react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { PageTitle } from "./PageTitle";
import { signOutAction } from "./signOutAction";
import type { Locale, Translator } from "@/lib/i18n";

export function Header({
  locale, t, titles, actions,
}: {
  locale: Locale;
  t: Translator;
  /** nav key → translated section title; PageTitle picks by live pathname. */
  titles: Record<string, string>;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-line bg-panel px-6 py-4 print:hidden">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/*
          Opens the off-canvas Sidebar drawer below `md` (768px) — see
          AppLayout for the `#mobile-nav-toggle` checkbox this targets and
          Sidebar.tsx for the `peer-checked:` classes it drives. A <label
          for> works regardless of where in the DOM it lives, unlike the
          `peer-*` Tailwind variant, which needs a sibling relationship.
        */}
        <label
          htmlFor="mobile-nav-toggle"
          aria-label={t("nav.openMenu")}
          className="-ms-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg
            text-navy hover:bg-surface md:hidden"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </label>
        <PageTitle locale={locale} titles={titles} />
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {actions}
        <LanguageSwitcher locale={locale} />
        <ThemeToggle label={t("app.themeToggle")} />
        {/* The signed-in name used to render here; removed at the owner's
            request 2026-08-05 — a single-user system tells its only user
            nothing by naming them. */}
        <form action={signOutAction}>
          <input type="hidden" name="locale" value={locale} />
          <button type="submit" className="text-sm text-muted hover:text-navy">
            {t("nav.signOut")}
          </button>
        </form>
      </div>
    </header>
  );
}

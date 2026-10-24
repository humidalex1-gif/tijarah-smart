import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { NAV_ITEMS } from "@/lib/nav";
import { can } from "@/lib/permissions";
import { loadAppContext } from "@/lib/appContext";
import { Sidebar } from "@/components/shell/Sidebar";
import { Header } from "@/components/shell/Header";
import { CloseMobileNavOnNavigate } from "@/components/shell/CloseMobileNavOnNavigate";
import { BottomNav } from "@/components/shell/BottomNav";

export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);

  // Onboarding is a one-time wizard gate: every (app) page requires it done,
  // not just the dashboard, since none of these screens make sense without a
  // warehouse/currency/tax rate already configured.
  if (!ctx.company.onboardingCompleted) {
    redirect(`/${locale}/onboarding`);
  }

  const t = await getTranslator(locale);

  // The ACTIVE state deliberately does not live here. A layout renders once
  // per hard load and never again during client-side navigation, so anything
  // derived from the request pathname (the old x-pathname header) froze: the
  // owner caught the sidebar highlighting المالية over المشتريات content.
  // Labels are computed here, where the translator lives; WHICH one is
  // current is resolved client-side from the live pathname (Sidebar,
  // PageTitle).
  const items = NAV_ITEMS
    .filter((item) => can(ctx.role, item.permission))
    .map((item) => ({ key: item.key, href: item.href, label: t(`nav.${item.key}`) }));
  const titles = Object.fromEntries(NAV_ITEMS.map((item) => [item.key, t(`nav.${item.key}`)]));

  // The phone's bottom bar: the four screens the owner lives in. Sliced from
  // the permission-filtered list — not from NAV_ITEMS — so a role that cannot
  // open a screen never sees its tab, by the same filter the sidebar uses.
  const BOTTOM_KEYS = ["quick", "dashboard", "sales", "expenses"];
  const bottomItems = items.filter((item) => BOTTOM_KEYS.includes(item.key));

  return (
    <div className="flex min-h-screen">
      {/*
        Mobile-nav drawer state, pure CSS: this checkbox is `peer` for
        Sidebar's root `<nav>` (`peer-checked:start-0`, see Sidebar.tsx) and
        for the backdrop label right below it. Both it and the backdrop
        must be siblings BEFORE Sidebar in the DOM for Tailwind's `peer-*`
        selector (a `~` general-sibling combinator) to reach it. Header's
        hamburger button targets the same id from anywhere else in the
        tree — a <label for> association isn't DOM-position-dependent the
        way `peer-*` is.
      */}
      <input type="checkbox" id="mobile-nav-toggle" className="peer sr-only" aria-hidden="true" />
      <label
        htmlFor="mobile-nav-toggle"
        aria-hidden="true"
        // `md:hidden!` (important) rather than plain `md:hidden`: the
        // checked-drawer rule (`peer-checked:block`) has HIGHER CSS
        // specificity than a plain `md:` variant (two conditions vs one),
        // so without forcing importance here, resizing past `md` while the
        // drawer happens to be open (e.g. rotating a tablet) would leave
        // this full-screen backdrop stuck covering the desktop layout —
        // confirmed by direct computed-style testing, not a hunch.
        className="fixed inset-0 z-30 hidden bg-black/40 peer-checked:block md:hidden!"
      />
      <Sidebar locale={locale} appName={t("app.name")} items={items} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header locale={locale} t={t} titles={titles} />
        <main className="flex-1 overflow-x-auto p-6 pb-24 md:pb-6">{children}</main>
      </div>
      <BottomNav locale={locale} items={bottomItems} />
      <CloseMobileNavOnNavigate />
    </div>
  );
}

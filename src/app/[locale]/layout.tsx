import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { isLocale, dirFor, getTranslator, getList, DEFAULT_LOCALE } from "@/lib/i18n";
import { THEME_INIT_SCRIPT } from "@/components/shell/ThemeToggle";
import { BRAND } from "@/lib/pwa";
import { InstallPanel } from "@/components/shell/InstallPanel";
import { ServiceWorker } from "@/components/shell/ServiceWorker";
import "../globals.css";

/**
 * One grotesque for both scripts.
 *
 * The app ran on the browser's default sans, which on Windows renders Arabic
 * in a UI face that undoes the rest of the Swiss system: the anchor asks for a
 * single grotesque used across display and body, and a typeface nobody chose
 * is the fastest way for a considered layout to still read as unconsidered.
 * IBM Plex Sans Arabic is drawn for both scripts, so headings and figures are
 * the same voice in either locale.
 *
 * next/font self-hosts the files at build time — no runtime request to Google,
 * which also means no third-party dependency on a page the merchant loads.
 */
const sans = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // An unknown segment is a mis-typed locale, not a missing page: send the
  // visitor to the same path under the default locale rather than 404ing
  // into a layout that has no <html> around it.
  if (!isLocale(locale)) redirect(`/${DEFAULT_LOCALE}`);

  const t = await getTranslator(locale);
  // Ordered steps, not a single string — resolved on the server so the panel
  // stays a plain client component with serializable props.
  const [iosSteps, androidSteps, desktopSteps] = await Promise.all([
    getList(locale, "install.iosSteps"),
    getList(locale, "install.androidSteps"),
    getList(locale, "install.desktopSteps"),
  ]);

  return (
    <html lang={locale} dir={dirFor(locale)} className={sans.variable} suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint. Without this the page
            renders light, then swaps once React hydrates — a visible flash on
            every single navigation for anyone using dark mode.
            suppressHydrationWarning above is required because this script
            mutates <html> before React sees it. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />

        {/* Installable on Android, Windows and iPhone from this one page.
            The manifest is per-locale because it carries the app's NAME, its
            reading direction and the URL it launches at, and all three differ
            between /ar and /en. */}
        <link rel="manifest" href={`/${locale}/manifest.webmanifest`} />
        <meta name="theme-color" content={BRAND} />

        {/* iOS ignores the manifest's icons and its display mode entirely.
            Without these three tags an iPhone "Add to Home Screen" produces a
            screenshot-thumbnail icon that still opens inside Safari's chrome. */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={t("app.name")} />
      </head>
      <body className="min-h-screen bg-surface text-ink antialiased">
        {children}
        <span className="sr-only">{t("app.name")}</span>

        {/* Registered here rather than inside the app shell: installability is
            judged on whatever page the owner happens to open, and that is the
            public landing page as often as it is a screen behind the login.
            It caches nothing (public/sw.js), so it cannot serve a stale figure. */}
        <ServiceWorker />

        {/* Offers the app on a laptop, an Android phone and an iPhone. It
            hides itself inside the installed app and after a dismissal, so
            placing it at the root costs nothing to someone who already has it. */}
        <InstallPanel
          labels={{
            title: t("install.title"),
            body: t("install.body"),
            install: t("install.install"),
            installing: t("install.installing"),
            dismiss: t("install.dismiss"),
            close: t("install.close"),
            stepsTitle: t("install.stepsTitle"),
            iosSteps,
            androidSteps,
            desktopSteps,
          }}
        />
      </body>
    </html>
  );
}

import type { Locale } from "@/lib/i18n";
import { appHomePath } from "@/lib/nav";

/**
 * The installable app — Android, Windows, and iPhone — from one manifest.
 *
 * No app store, no review queue, no second codebase. The owner opens the site
 * and installs it: Chrome and Edge show an install button, and iOS installs
 * through Share -> Add to Home Screen. For a private single-merchant tool
 * that is the correct shape, and it is what stage 3 of the quick-entry design
 * already called for.
 *
 * Everything here is DERIVED rather than hand-written into a static JSON file,
 * because the two facts that matter most — the app's name and the locale it
 * opens in — already live in the message catalogues and the router.
 */

/** The Swiss accent the app actually paints with (globals.css `--color-brand`). */
export const BRAND = "#002fa7";
/** `--color-surface`: the page ground, so the splash does not flash white. */
export const BACKGROUND = "#f4f4f5";

const NAME: Record<Locale, string> = {
  ar: "تجارة سمارت",
  en: "Tijarah Smart",
};

/** Under an icon, both platforms truncate past ~12 characters. */
const SHORT_NAME: Record<Locale, string> = {
  ar: "تجارة",
  en: "Tijarah",
};

const DESCRIPTION: Record<Locale, string> = {
  ar: "تسجيل المصروفات والمبيعات ومتابعة الربح الحقيقي.",
  en: "Record expenses and sales, and follow real profit.",
};

const SHORTCUT: Record<Locale, { name: string; short_name: string }> = {
  ar: { name: "الإدخال السريع", short_name: "إدخال" },
  en: { name: "Quick entry", short_name: "Entry" },
};

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
}

export interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: "rtl" | "ltr";
  start_url: string;
  scope: string;
  display: "standalone";
  display_override: string[];
  orientation: "portrait" | "any";
  theme_color: string;
  background_color: string;
  icons: WebManifestIcon[];
  shortcuts: { name: string; short_name: string; url: string }[];
}

export function buildManifest(locale: Locale): WebManifest {
  return {
    name: NAME[locale],
    short_name: SHORT_NAME[locale],
    description: DESCRIPTION[locale],
    lang: locale,
    dir: locale === "ar" ? "rtl" : "ltr",
    // Straight into quick entry. An icon on the home screen exists to be one
    // tap from recording something; opening the marketing page or the
    // dashboard instead would make the install pointless.
    start_url: appHomePath(locale),
    // The whole origin, so following a link to /sales inside the installed
    // window stays in the app instead of bouncing out to the browser.
    scope: "/",
    display: "standalone",
    // `window-controls-overlay` was requested here and is NOT asked for now.
    // It hands the app the title-bar strip to draw itself, and nothing in this
    // codebase reads `env(titlebar-area-*)` — so on Windows the installed
    // window would paint its content under the caption buttons. The comment
    // that justified it ("an installed window can open at a phone width") was
    // wrong too: that is layout, not display mode.
    display_override: ["standalone", "minimal-ui", "browser"],
    orientation: "portrait",
    theme_color: BRAND,
    background_color: BACKGROUND,
    icons: [
      // 192 and 512 are both REQUIRED by Chrome's installability check.
      // Missing either is the commonest reason an install prompt never shows.
      { src: `/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      // Android crops icons to the device's shape; a non-maskable icon loses
      // its edges to that crop.
      { src: `/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { ...SHORTCUT[locale], url: `/${locale}/quick` },
    ],
  };
}

/**
 * The mark: the letter ت reduced to its two signals — the bowl and the two
 * dots ABOVE it. The dots' position is the whole letter: two dots below the
 * bar is ي, not ت, and a first draft of this icon had exactly that.
 *
 * Drawn rather than photographed so it stays crisp at 48px and needs no
 * binary source in git.
 */
export const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Tijarah Smart">
  <rect width="512" height="512" fill="#002fa7"/>
  <circle cx="212" cy="196" r="24" fill="#ffffff"/>
  <circle cx="300" cy="196" r="24" fill="#ffffff"/>
  <rect x="96" y="288" width="320" height="30" fill="#ffffff"/>
  <rect x="96" y="288" width="30" height="72" fill="#ffffff"/>
  <rect x="386" y="288" width="30" height="72" fill="#ffffff"/>
</svg>`;

/**
 * The same mark inside the maskable safe zone.
 *
 * Android may crop up to 20% from every edge, so the artwork is scaled to the
 * inner 60% and the accent is allowed to bleed to the full canvas — the crop
 * then takes colour, never the mark.
 */
export const MASKABLE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Tijarah Smart">
  <rect width="512" height="512" fill="#002fa7"/>
  <g transform="translate(102 102) scale(0.6)">
    <circle cx="212" cy="196" r="24" fill="#ffffff"/>
    <circle cx="300" cy="196" r="24" fill="#ffffff"/>
    <rect x="96" y="288" width="320" height="30" fill="#ffffff"/>
    <rect x="96" y="288" width="30" height="72" fill="#ffffff"/>
    <rect x="386" y="288" width="30" height="72" fill="#ffffff"/>
  </g>
</svg>`;

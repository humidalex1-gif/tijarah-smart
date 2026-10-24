import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { buildManifest } from "@/lib/pwa";

/**
 * The web app manifest, served PER LOCALE.
 *
 * A single static `/manifest.json` could not do this: the manifest carries the
 * app's name, its reading direction and the URL it launches at, and all three
 * differ between `/ar` and `/en`. An Arabic merchant installing from the
 * Arabic app must get an Arabic name and an Arabic start URL — otherwise the
 * icon on their phone opens the English marketing path.
 *
 * Public on purpose, and safe: nothing here is tenant data. It is the same
 * five facts the browser could read off the page anyway.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string }> },
) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return Response.json(buildManifest(locale), {
    headers: {
      "Content-Type": "application/manifest+json",
      // Long-lived but revalidated: the manifest changes only when the app's
      // name or start URL does, and a stale one silently keeps an old icon.
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}

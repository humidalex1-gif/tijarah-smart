import Link from "next/link";
import { DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";

// Next.js does not pass route params to `not-found.tsx` (it renders for any
// unmatched segment under this layout), so the locale can't be read from the
// URL here. Rendering with DEFAULT_LOCALE keeps this file simple and correct
// under Next's documented constraints; the surrounding <html lang>/<dir> set
// by the parent layout still reflect the real requested locale.
export default async function LocaleNotFound() {
  const t = await getTranslator(DEFAULT_LOCALE);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-lg font-medium text-navy">{t("errors.NOT_FOUND")}</p>
      <Link
        href={`/${DEFAULT_LOCALE}`}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink transition hover:opacity-90"
      >
        {t("app.back")}
      </Link>
    </div>
  );
}

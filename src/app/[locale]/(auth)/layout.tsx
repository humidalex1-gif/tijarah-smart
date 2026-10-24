import type { ReactNode } from "react";
import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/shell/LanguageSwitcher";
import { TijarahLogo } from "../(marketing)/Logo";

export default async function AuthLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslator(locale);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-surface px-4 py-12">
      <div className="flex items-center gap-4">
        {/* The logo IS the way back: login is a dead end otherwise, and the
            owner asked for a route home (2026-08-05). aria-label because the
            wordmark image text alone does not say where the link goes. */}
        <Link
          href={`/${locale}`}
          aria-label={t("app.name")}
          className="text-navy transition-opacity hover:opacity-80"
        >
          <TijarahLogo markClass="h-8 w-8" textClass="text-lg" />
        </Link>
        <LanguageSwitcher locale={locale} />
      </div>
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}

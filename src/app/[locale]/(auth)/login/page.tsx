import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslator(locale);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-navy">{t("auth.signInTitle")}</h1>
      </div>

      <LoginForm
        locale={locale}
        labels={{
          email: t("auth.email"),
          password: t("auth.password"),
          submit: t("auth.signIn"),
          error: t("auth.invalidCredentials"),
        }}
      />

      <p className="text-xs text-muted">{t("auth.passwordResetHint")}</p>

      <p className="text-sm text-muted">
        {t("auth.noAccount")}{" "}
        <Link href={`/${locale}/register`} className="font-medium text-brand hover:underline">
          {t("auth.register")}
        </Link>
      </p>
    </div>
  );
}

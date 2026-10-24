import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { RegisterForm } from "./RegisterForm";

export default async function RegisterPage({
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
        <h1 className="text-xl font-semibold text-navy">{t("auth.registerTitle")}</h1>
      </div>

      <RegisterForm
        locale={locale}
        labels={{
          fullName: t("auth.fullName"),
          companyName: t("auth.companyName"),
          email: t("auth.email"),
          password: t("auth.password"),
          submit: t("auth.register"),
          // registerAction can return "errors.generic" (validation) or
          // "errors.<ServiceError code>" (e.g. EMAIL_ALREADY_REGISTERED,
          // PASSWORD_TOO_SHORT) — the client picks the right translation by
          // key instead of always showing the generic message.
          errors: {
            "errors.generic": t("errors.generic"),
            "errors.EMAIL_ALREADY_REGISTERED": t("errors.EMAIL_ALREADY_REGISTERED"),
            "errors.PASSWORD_TOO_SHORT": t("errors.PASSWORD_TOO_SHORT"),
            "errors.INVALID_NAME": t("errors.INVALID_NAME"),
            "errors.INVALID_EMAIL": t("errors.INVALID_EMAIL"),
          },
        }}
      />

      <p className="text-sm text-muted">
        {t("auth.haveAccount")}{" "}
        <Link href={`/${locale}/login`} className="font-medium text-brand hover:underline">
          {t("auth.signIn")}
        </Link>
      </p>
    </div>
  );
}

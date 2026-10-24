import { redirect } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { requireSessionOrRedirect } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { OnboardingForm } from "./OnboardingForm";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslator(locale);

  const session = await requireSessionOrRedirect(locale);

  // The JWT is a cache, not authority (docs/decisions.md #2): a token can
  // outlive the row it points at (e.g. the company was deleted, or this is
  // stale test/dev data) for up to its 24h maxAge. Treat that as
  // unauthenticated rather than crashing with an unhandled P2025.
  const company = await prisma.company.findUnique({
    where: { id: session.companyId },
  });
  if (!company) redirect(`/${locale}/login`);

  // Onboarding is a one-time wizard: a company that already finished it
  // (e.g. a teammate signing in later, or a page revisit) goes straight to
  // the dashboard instead of being asked to redo setup.
  if (company.onboardingCompleted) redirect(`/${locale}/dashboard`);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <h1 className="mb-8 text-2xl font-semibold text-navy">{t("onboarding.title")}</h1>

      <OnboardingForm
        locale={locale}
        defaults={{
          companyName: company.name,
          currencyCode: company.currencyCode,
          taxRatePct: company.defaultTaxRatePct,
          // The default VALUE, not just the label, in the merchant's own
          // locale — a merchant who accepts the default used to get an
          // English warehouse name ("Main Warehouse") on every inventory,
          // transfer, movement and sale screen forever, even in the Arabic
          // app (Stage 1B review, IMPORTANT 7).
          warehouseName: t("onboarding.warehouseNameDefault"),
        }}
        labels={{
          title: t("onboarding.title"),
          companyStep: t("onboarding.companyStep"),
          financeStep: t("onboarding.financeStep"),
          warehouseStep: t("onboarding.warehouseStep"),
          companyName: t("auth.companyName"),
          currency: t("onboarding.currency"),
          taxRate: t("onboarding.taxRate"),
          warehouseName: t("onboarding.warehouseName"),
          openingCash: t("onboarding.openingCash"),
          openingBank: t("onboarding.openingBank"),
          submit: t("app.finish"),
          // action() returns a translation KEY, never text — the client
          // looks it up here instead of rendering the raw key. Covers every
          // top-level error onboardingAction can return (a non-OWNER used to
          // see the generic message for both FORBIDDEN and
          // ONBOARDING_ALREADY_COMPLETED — Stage 1B review, IMPORTANT 6) and
          // every field-level validation code the schema can produce.
          errors: {
            "errors.generic": t("errors.generic"),
            "errors.FORBIDDEN": t("errors.FORBIDDEN"),
            "errors.ONBOARDING_ALREADY_COMPLETED": t("errors.ONBOARDING_ALREADY_COMPLETED"),
            "errors.INVALID_NAME": t("errors.INVALID_NAME"),
            "errors.INVALID_CURRENCY_CODE": t("errors.INVALID_CURRENCY_CODE"),
            "errors.INVALID_TAX_RATE": t("errors.INVALID_TAX_RATE"),
            "errors.INVALID_AMOUNT": t("errors.INVALID_AMOUNT"),
          },
        }}
      />
    </div>
  );
}

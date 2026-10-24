import Link from "next/link";
import type { Locale, Translator } from "@/lib/i18n";
import type { Role } from "@/lib/constants";
import { can } from "@/lib/permissions";

/**
 * Sub-navigation shared by every /finance/* page: a tab row (overview,
 * accounts, transactions) plus the record-payment entry point, mirroring
 * InventoryNav's shape (src/app/[locale]/(app)/inventory/InventoryNav.tsx).
 */
export function FinanceNav({
  locale, role, t, active,
}: {
  locale: Locale; role: Role; t: Translator; active: "overview" | "accounts" | "transactions";
}) {
  const tabs = [
    { key: "overview" as const, href: `/${locale}/finance`, label: t("finance.title") },
    { key: "accounts" as const, href: `/${locale}/finance/accounts`, label: t("finance.accounts") },
    { key: "transactions" as const, href: `/${locale}/finance/transactions`, label: t("finance.transactions") },
  ];

  const canRecordPayment = can(role, "payments.create");

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              active === tab.key
                ? "border-brand bg-brand text-brand-ink"
                : "border-line bg-panel text-navy hover:bg-surface"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {canRecordPayment ? (
        <Link
          href={`/${locale}/finance/payments/new`}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink"
        >
          {t("finance.recordPayment")}
        </Link>
      ) : null}
    </div>
  );
}

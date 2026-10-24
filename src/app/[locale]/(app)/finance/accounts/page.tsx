import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatBusinessDate } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { AccountType } from "@/lib/constants";
import { FinanceNav } from "../FinanceNav";
import { AddAccountForm, type AddAccountFormLabels } from "./AddAccountForm";

export default async function FinanceAccountsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "finance.view", locale);
  const t = await getTranslator(locale);

  const canManage = can(ctx.role, "finance.manage_accounts");

  // ACTIVE only — matches services/reporting.ts's cashPosition() exactly,
  // which is what the finance overview page's cash/bank/total KPI cards sum.
  // Unlike suppliers/customers/warehouses (which list every status with a
  // badge, since an inactive one still has real historical orders/ledger
  // value), an archived FinancialAccount has no such ongoing reference value
  // once retired — showing it here with a balance the overview KPIs don't
  // count would read as the two screens disagreeing about the same number.
  const accounts = await prisma.financialAccount.findMany({
    where: { companyId: ctx.companyId, status: "ACTIVE" },
    orderBy: { name: "asc" },
  });

  // Per-account "last transaction" spans two source tables (a payment
  // through EITHER leg — accountId or, for a transfer, destinationAccountId
  // — and an expense, which deliberately writes no Payment row at all;
  // docs/decisions.md #5). The accounts list is always short (one row per
  // financial account a company has), so one pair of queries per account is
  // fine here, unlike the transactions page below which unions the full
  // history.
  const lastActivity = await Promise.all(accounts.map(async (account) => {
    const [lastPayment, lastExpense] = await Promise.all([
      prisma.payment.findFirst({
        where: { companyId: ctx.companyId, OR: [{ accountId: account.id }, { destinationAccountId: account.id }] },
        orderBy: { paymentDate: "desc" },
        select: { paymentDate: true },
      }),
      prisma.expense.findFirst({
        where: { companyId: ctx.companyId, accountId: account.id },
        orderBy: { expenseDate: "desc" },
        select: { expenseDate: true },
      }),
    ]);
    const dates = [lastPayment?.paymentDate, lastExpense?.expenseDate]
      .filter((d): d is Date => d !== undefined);
    return dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
  }));

  const rows = accounts.map((a, i) => ({ ...a, id: a.id, lastActivity: lastActivity[i] }));

  const columns: Column<typeof rows[number]>[] = [
    { key: "name", header: t("finance.accountName"), render: (a) => a.name },
    {
      key: "type", header: t("finance.accountType"),
      render: (a) => t(`finance.accountTypeOptions.${a.accountType as AccountType}`),
    },
    {
      key: "balance", header: t("finance.balance"), align: "end",
      render: (a) => <Money minor={a.currentBalance} locale={locale} currency={ctx.currency} tone="auto" />,
    },
    {
      key: "lastActivity", header: t("finance.lastTransaction"),
      render: (a) => (a.lastActivity ? formatBusinessDate(a.lastActivity, locale) : "—"),
    },
    {
      key: "status", header: t("app.status"),
      render: (a) => <StatusBadge label={t(`status.${a.status}`)} tone={a.status === "ACTIVE" ? "success" : "neutral"} />,
    },
  ];

  const addAccountLabels: AddAccountFormLabels = {
    accountName: t("finance.accountName"), accountType: t("finance.accountType"),
    openingBalance: t("finance.openingBalance"),
    accountTypeOptions: {
      CASH: t("finance.accountTypeOptions.CASH"), BANK: t("finance.accountTypeOptions.BANK"),
    },
    addAccount: t("finance.addAccount"), save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    addAccountConfirmTitle: t("finance.addAccountConfirmTitle"),
    addAccountConfirmMessage: t("finance.addAccountConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.DUPLICATE_ACCOUNT_NAME": t("errors.DUPLICATE_ACCOUNT_NAME"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
    },
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-navy">{t("finance.accounts")}</h1>
      </div>
      <FinanceNav locale={locale} role={ctx.role} t={t} active="accounts" />

      {canManage ? (
        <div className="mb-4">
          <AddAccountForm labels={addAccountLabels} />
        </div>
      ) : null}

      <DataTable columns={columns} rows={rows} empty={<EmptyState message={t("finance.emptyAccounts")} />} />
    </div>
  );
}

import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ExpenseFilters } from "./ExpenseFilters";

// Same page size/DB-level pagination as the purchases and movements lists.
const PAGE_SIZE = 50;

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export default async function ExpensesPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "expenses.view", locale);
  const t = await getTranslator(locale);

  const canCreate = can(ctx.role, "expenses.create");

  const categoryFilter = typeof sp.category === "string" ? sp.category : "";
  const accountFilter = typeof sp.account === "string" ? sp.account : "";
  const statusFilter = typeof sp.status === "string" ? sp.status : "";
  const fromFilter = typeof sp.from === "string" && isIsoDay(sp.from) ? sp.from : "";
  const toFilter = typeof sp.to === "string" && isIsoDay(sp.to) ? sp.to : "";

  // Both endpoint days fully included — same UTC-day-window convention as
  // services/reporting.ts's `dayWindow` and the inventory movements list.
  const expenseDate = (fromFilter || toFilter) ? {
    ...(fromFilter ? { gte: new Date(`${fromFilter}T00:00:00.000Z`) } : {}),
    ...(toFilter ? { lt: new Date(new Date(`${toFilter}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
  } : undefined;

  const where = {
    companyId: ctx.companyId,
    ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    ...(accountFilter ? { accountId: accountFilter } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(expenseDate ? { expenseDate } : {}),
  };

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const [expenses, total, categories, accounts] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        category: { select: { nameAr: true, nameEn: true } },
        account: { select: { name: true } },
      },
      orderBy: { expenseDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.expense.count({ where }),
    prisma.expenseCategory.findMany({ where: { companyId: ctx.companyId }, orderBy: { nameEn: "asc" } }),
    prisma.financialAccount.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" } }),
  ]);

  const rows = expenses.map((e) => ({ ...e, id: e.id }));

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "number", header: t("expenses.number"),
      render: (e) => (
        <Link href={`/${locale}/expenses/${e.id}`} className="font-medium text-brand hover:underline">
          {e.expenseNumber}
        </Link>
      ),
    },
    { key: "date", header: t("expenses.date"), render: (e) => formatBusinessDate(e.expenseDate, locale) },
    { key: "description", header: t("expenses.description"), render: (e) => e.description },
    {
      key: "category", header: t("expenses.category"),
      render: (e) => (locale === "ar" ? e.category.nameAr : e.category.nameEn),
    },
    {
      key: "amount", header: t("expenses.amount"), align: "end",
      render: (e) => <Money minor={e.amount} locale={locale} currency={ctx.currency} />,
    },
    {
      key: "total", header: t("expenses.total"), align: "end",
      render: (e) => <Money minor={e.totalAmount} locale={locale} currency={ctx.currency} />,
    },
    { key: "account", header: t("expenses.paidFrom"), render: (e) => e.account.name },
    {
      key: "status", header: t("app.status"),
      render: (e) => (
        <StatusBadge
          label={t(`status.${e.status}`)}
          tone={e.status === "CANCELLED" ? "danger" : "success"}
        />
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <a href={`/${locale}/export/expenses`} className="rounded-lg border border-line px-4 py-2 text-sm text-navy">
          {t("app.exportCsv")}
        </a>
        {canCreate ? (
          <Link
            href={`/${locale}/expenses/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("expenses.add")}
          </Link>
        ) : null}
      </div>

      <div className="mb-4">
        <PageHelp t={t} pageKey="expenses" />
      </div>

      <ExpenseFilters
        categories={categories.map((c) => ({ id: c.id, label: locale === "ar" ? c.nameAr : c.nameEn }))}
        accounts={accounts.map((a) => ({ id: a.id, label: a.name }))}
        statuses={["CONFIRMED", "CANCELLED"].map((s) => ({ id: s, label: t(`status.${s}`) }))}
        current={{
          category: categoryFilter, account: accountFilter, status: statusFilter,
          from: fromFilter, to: toFilter,
        }}
        labels={{
          category: t("expenses.category"), account: t("finance.accounts"), status: t("app.status"),
          dateFrom: t("inventory.dateFrom"), dateTo: t("inventory.dateTo"),
          all: t("app.all"), search: t("app.search"),
        }}
      />

      <DataTable columns={columns} rows={rows} empty={
          <EmptyState
            message={t("expenses.empty")}
            actionLabel={canCreate ? t("expenses.add") : undefined}
            actionHref={canCreate ? `/${locale}/expenses/new` : undefined}
          />
        } />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => {
          const params = new URLSearchParams();
          if (categoryFilter) params.set("category", categoryFilter);
          if (accountFilter) params.set("account", accountFilter);
          if (statusFilter) params.set("status", statusFilter);
          if (fromFilter) params.set("from", fromFilter);
          if (toFilter) params.set("to", toFilter);
          if (target > 1) params.set("page", String(target));
          const qs = params.toString();
          return `/${locale}/expenses${qs ? `?${qs}` : ""}`;
        }}
        labels={{
          previous: t("app.previous"), next: t("app.next"),
          pageInfo: t("app.pageOf", {
            page: formatNumber(page, locale),
            pages: formatNumber(Math.max(1, Math.ceil(total / PAGE_SIZE)), locale),
          }),
        }}
      />
    </div>
  );
}

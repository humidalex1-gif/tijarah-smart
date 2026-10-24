import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { FinanceNav } from "../FinanceNav";
import { TransactionFilters } from "./TransactionFilters";

// Same page size as every other Task 5-9 list. Paginated in-memory (slice),
// not via Prisma skip/take: this list is a UNION of two tables (Payment and
// Expense — expenses deliberately write no Payment row, docs/decisions.md
// #5), so the merged, date-sorted set can only be known after both queries
// run. DB-level pagination applied to either source alone would slice an
// inconsistent, source-order-dependent page — same rationale as the
// suppliers list's `?filter=owing` in-memory pagination.
const PAGE_SIZE = 50;

const FILTERABLE_TYPES = ["CUSTOMER_PAYMENT", "SUPPLIER_PAYMENT", "ACCOUNT_TRANSFER", "REFUND", "EXPENSE"] as const;

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isInflow(paymentType: string): boolean {
  return paymentType === "CUSTOMER_PAYMENT" || paymentType === "OWNER_CONTRIBUTION";
}

export default async function FinanceTransactionsPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "finance.view", locale);
  const t = await getTranslator(locale);

  // t() returns the bare key on a miss (src/lib/i18n.ts), same fallback
  // pattern as the supplier statement's statementTypeLabel — covers a
  // paymentType this page doesn't have a dedicated label for (OWNER_* exist
  // in PAYMENT_TYPES but have no service behind them in Stage 1).
  function typeLabel(type: string): string {
    const label = t(`finance.paymentTypeOptions.${type}`);
    return label.startsWith("finance.paymentTypeOptions.") ? type : label;
  }

  const accountFilter = typeof sp.account === "string" ? sp.account : "";
  const typeFilter = typeof sp.type === "string" ? sp.type : "";
  const fromFilter = typeof sp.from === "string" && isIsoDay(sp.from) ? sp.from : "";
  const toFilter = typeof sp.to === "string" && isIsoDay(sp.to) ? sp.to : "";

  const dateWindow = (fromFilter || toFilter) ? {
    ...(fromFilter ? { gte: new Date(`${fromFilter}T00:00:00.000Z`) } : {}),
    ...(toFilter ? { lt: new Date(new Date(`${toFilter}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
  } : undefined;

  const includePayments = !typeFilter || typeFilter !== "EXPENSE";
  const includeExpenses = !typeFilter || typeFilter === "EXPENSE";

  const [payments, expenses, accounts] = await Promise.all([
    includePayments
      ? prisma.payment.findMany({
          where: {
            companyId: ctx.companyId,
            status: "CONFIRMED",
            ...(accountFilter ? { OR: [{ accountId: accountFilter }, { destinationAccountId: accountFilter }] } : {}),
            ...(typeFilter ? { paymentType: typeFilter } : {}),
            ...(dateWindow ? { paymentDate: dateWindow } : {}),
          },
          include: {
            customer: { select: { name: true } },
            supplier: { select: { name: true } },
            account: { select: { name: true } },
            destination: { select: { name: true } },
          },
          orderBy: { paymentDate: "desc" },
        })
      : Promise.resolve([]),
    includeExpenses
      ? prisma.expense.findMany({
          where: {
            companyId: ctx.companyId,
            status: "CONFIRMED",
            ...(accountFilter ? { accountId: accountFilter } : {}),
            ...(dateWindow ? { expenseDate: dateWindow } : {}),
          },
          include: { account: { select: { name: true } } },
          orderBy: { expenseDate: "desc" },
        })
      : Promise.resolve([]),
    prisma.financialAccount.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" } }),
  ]);

  function paymentDescription(p: (typeof payments)[number]): string {
    if (p.paymentType === "CUSTOMER_PAYMENT") return p.customer?.name ?? "";
    if (p.paymentType === "SUPPLIER_PAYMENT" || p.paymentType === "REFUND") return p.supplier?.name ?? p.customer?.name ?? "";
    return p.notes ?? "";
  }

  // An ACCOUNT_TRANSFER is one Payment row but two real cash movements — an
  // outflow from `accountId` and an equal inflow into `destinationAccountId`.
  // Emitting only the outflow leg (the original version of this page) made
  // the destination account's own money-in never show up here at all, so
  // this list's per-account in/out could never be reconciled against
  // cashPosition() (services/reporting.ts), which sums BOTH accounts'
  // currentBalance. Emit both legs, each tagged with the account it actually
  // moved money through, so the two figures agree.
  function paymentRows(p: (typeof payments)[number]) {
    if (p.paymentType === "ACCOUNT_TRANSFER" && p.destination) {
      return [
        {
          id: `payment-${p.id}-out`, date: p.paymentDate, type: p.paymentType,
          description: p.destination.name, accountId: p.accountId, account: p.account.name,
          amountIn: 0, amountOut: p.amount, reference: p.paymentNumber,
          entityKey: `PAYMENT:${p.id}`,
        },
        {
          id: `payment-${p.id}-in`, date: p.paymentDate, type: p.paymentType,
          description: p.account.name, accountId: p.destinationAccountId as string, account: p.destination.name,
          amountIn: p.amount, amountOut: 0, reference: p.paymentNumber,
          entityKey: `PAYMENT:${p.id}`,
        },
      ];
    }
    return [{
      id: `payment-${p.id}`, date: p.paymentDate, type: p.paymentType,
      description: paymentDescription(p), accountId: p.accountId, account: p.account.name,
      amountIn: isInflow(p.paymentType) ? p.amount : 0,
      amountOut: isInflow(p.paymentType) ? 0 : p.amount,
      reference: p.paymentNumber,
      // Kept unprefixed alongside the display id: this is the only screen a
      // payment appears on, so without it a receipt uploaded with the payment
      // would be stored and never shown again.
      entityKey: `PAYMENT:${p.id}`,
    }];
  }

  const expenseRows = expenses.map((e) => ({
    id: `expense-${e.id}`,
    date: e.expenseDate,
    type: "EXPENSE",
    description: e.description,
    accountId: e.accountId, account: e.account.name,
    amountIn: 0,
    amountOut: e.totalAmount,
    reference: e.expenseNumber,
    entityKey: `EXPENSE:${e.id}`,
  }));

  const mergedRows = [...payments.flatMap(paymentRows), ...expenseRows]
    // The DB query above fetches a transfer touching accountFilter through
    // EITHER leg (an OR on accountId/destinationAccountId), so a filtered
    // view must still drop whichever generated leg belongs to the OTHER
    // account — showing both legs there would misattribute money movement
    // to an account the merchant didn't ask to see.
    .filter((r) => !accountFilter || r.accountId === accountFilter)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const total = mergedRows.length;
  const rows = mergedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Only for the page on screen. Fetching documents for every transaction
  // ever recorded to render fifty rows would grow with the history rather
  // than with the view.
  const attachments = await prisma.attachment.findMany({
    where: {
      companyId: ctx.companyId,
      OR: [...new Set(rows.map((r) => r.entityKey))].map((key) => {
        const [entityType, entityId] = key.split(":");
        return { entityType, entityId };
      }),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, entityType: true, entityId: true },
  });
  // Newest first above, and `set` keeps the LAST write — so iterate in reverse
  // to leave the newest document as the one the row links to.
  const attachmentByEntity = new Map(
    [...attachments].reverse().map((a) => [`${a.entityType}:${a.entityId}`, a]),
  );

  const columns: Column<typeof rows[number]>[] = [
    { key: "date", header: t("app.date"), render: (r) => formatBusinessDate(r.date, locale) },
    { key: "type", header: t("finance.type"), render: (r) => typeLabel(r.type) },
    { key: "description", header: t("expenses.description"), render: (r) => r.description || "—" },
    { key: "account", header: t("finance.accounts"), render: (r) => r.account },
    {
      key: "in", header: t("finance.amountIn"), align: "end",
      render: (r) => (r.amountIn > 0 ? <Money minor={r.amountIn} locale={locale} currency={ctx.currency} tone="auto" /> : "—"),
    },
    {
      key: "out", header: t("finance.amountOut"), align: "end",
      render: (r) => (r.amountOut > 0 ? <Money minor={-r.amountOut} locale={locale} currency={ctx.currency} tone="auto" /> : "—"),
    },
    { key: "reference", header: t("purchases.referenceNumber"), render: (r) => r.reference },
    {
      key: "document", header: t("expenses.documents"),
      render: (r) => {
        const attachment = attachmentByEntity.get(r.entityKey);
        return attachment ? (
          <Link
            href={`/${locale}/attachments/${attachment.id}`}
            target="_blank"
            rel="noreferrer"
            className="text-brand hover:underline"
            title={attachment.fileName}
          >
            {t("expenses.attachOpen")}
          </Link>
        ) : "—";
      },
    },
  ];

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-navy">{t("finance.transactions")}</h1>
      <FinanceNav locale={locale} role={ctx.role} t={t} active="transactions" />

      <TransactionFilters
        accounts={accounts.map((a) => ({ id: a.id, label: a.name }))}
        types={FILTERABLE_TYPES.map((ty) => ({ id: ty, label: typeLabel(ty) }))}
        current={{ account: accountFilter, type: typeFilter, from: fromFilter, to: toFilter }}
        labels={{
          account: t("finance.accounts"), type: t("finance.type"),
          dateFrom: t("inventory.dateFrom"), dateTo: t("inventory.dateTo"), all: t("app.all"),
        }}
      />

      <DataTable columns={columns} rows={rows} empty={<EmptyState message={t("finance.emptyTransactions")} />} />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => {
          const params = new URLSearchParams();
          if (accountFilter) params.set("account", accountFilter);
          if (typeFilter) params.set("type", typeFilter);
          if (fromFilter) params.set("from", fromFilter);
          if (toFilter) params.set("to", toFilter);
          if (target > 1) params.set("page", String(target));
          const qs = params.toString();
          return `/${locale}/finance/transactions${qs ? `?${qs}` : ""}`;
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

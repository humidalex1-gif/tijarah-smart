import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { customerBalance } from "@/services/ledger";
import { LIVE_ORDER_STATUSES } from "@/services/reporting";
import { fromMinor } from "@/lib/money";
import { CUSTOMER_TYPES, type CustomerType } from "@/lib/constants";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CustomerEditSection } from "./CustomerEditSection";
import type { CustomerFormLabels } from "../CustomerForm";

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "CONFIRMED") return "success";
  if (status === "CANCELLED") return "danger";
  return "neutral";
}
function paymentTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "PAID") return "success";
  if (status === "PARTIAL") return "warning";
  return "neutral";
}

// Same page size as the suppliers statement (src/app/[locale]/(app)/suppliers/[id]/page.tsx)
// — a long-lived customer's ledger only grows, so the statement paginates
// like every other unbounded Task 5-9 list rather than rendering every row.
const PAGE_SIZE = 50;

export default async function CustomerDetailPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;
  const rawPage = typeof sp.page === "string" ? Number(sp.page) : undefined;
  const requestedPage = rawPage !== undefined && Number.isFinite(rawPage) && rawPage >= 1
    ? Math.floor(rawPage)
    : undefined;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "customers.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter —
  // same tenant-boundary rule as every other Task 5-9 detail page.
  const customer = await prisma.customer.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!customer) notFound();

  const canEdit = can(ctx.role, "customers.edit");

  function typeLabel(customerType: string): string {
    const label = t(`customers.${customerType.toLowerCase()}`);
    return label.startsWith("customers.") ? customerType : label;
  }
  // t() returns the bare key on a miss (src/lib/i18n.ts), so an unrecognized
  // transactionType still shows something on screen — same fallback pattern
  // as suppliers' statementTypeLabel.
  function statementTypeLabel(transactionType: string): string {
    const label = t(`customers.statementTypeOptions.${transactionType}`);
    return label.startsWith("customers.statementTypeOptions.") ? transactionType : label;
  }

  const statementWhere = { customerId: customer.id, companyId: ctx.companyId };

  const [balance, salesOrders, payments, returns, statementTotal] = await Promise.all([
    customerBalance(prisma, ctx.companyId, customer.id),
    prisma.salesOrder.findMany({
      where: { customerId: customer.id, companyId: ctx.companyId },
      orderBy: { orderDate: "desc" },
    }),
    prisma.payment.findMany({
      where: { customerId: customer.id, companyId: ctx.companyId },
      include: { account: { select: { name: true } } },
      orderBy: { paymentDate: "desc" },
    }),
    prisma.customerReturn.findMany({
      where: { customerId: customer.id, companyId: ctx.companyId },
      include: { salesOrder: { select: { salesOrderNumber: true } } },
      orderBy: { returnDate: "desc" },
    }),
    prisma.customerLedgerEntry.count({ where: statementWhere }),
  ]);

  // The statement is ordered oldest-first so the running balance reads
  // top-to-bottom in the order it actually accumulated — defaulting to the
  // LAST page (not page 1) so the merchant lands on current activity, not
  // the oldest 50 rows. Same rationale as suppliers/[id]/page.tsx.
  const lastPage = Math.max(1, Math.ceil(statementTotal / PAGE_SIZE));
  // Clamped, not used raw — an out-of-range `?page=` (typed in directly, or
  // left stale in a bookmark/link after the statement shrinks) would
  // otherwise `skip` past every row and silently render an empty table
  // instead of the nearest real page.
  const page = Math.min(requestedPage ?? lastPage, lastPage);

  const statement = await prisma.customerLedgerEntry.findMany({
    where: statementWhere,
    orderBy: { createdAt: "asc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // LIVE orders only (CONFIRMED/COMPLETED) — `status !== "CANCELLED"` used
  // to admit DRAFT too, and confirmSale deliberately strands a DRAFT order
  // when it throws (e.g. insufficient stock), so a customer whose sale
  // failed repeatedly showed phantom orders here. Same basis as the
  // dashboard's identically-labelled "Total sales" KPI (salesSummary in
  // src/services/reporting.ts): subtotal + shippingCharged - refundedAmount,
  // tax-EXCLUSIVE — this used to be grandTotal - refundedAmount
  // (tax-inclusive), a different number under the same label on two screens
  // (Stage 1B review, IMPORTANT 4).
  const totalSales = salesOrders
    .filter((o) => LIVE_ORDER_STATUSES.includes(o.status))
    .reduce((s, o) => s + o.subtotal + o.shippingCharged - o.refundedAmount, 0);

  const orderColumns: Column<typeof salesOrders[number]>[] = [
    {
      key: "number", header: t("sales.orderNumber"),
      render: (o) => (
        <Link href={`/${locale}/sales/${o.id}`} className="font-medium text-brand hover:underline">
          {o.salesOrderNumber}
        </Link>
      ),
    },
    { key: "orderDate", header: t("purchases.orderDate"), render: (o) => formatBusinessDate(o.orderDate, locale) },
    {
      key: "total", header: t("purchases.grandTotal"), align: "end",
      render: (o) => <Money minor={o.grandTotal} locale={locale} currency={ctx.currency} />,
    },
    {
      key: "paymentStatus", header: t("purchases.paymentStatus"),
      // Same CANCELLED-aware rendering as the sales list/detail pages —
      // cancelSale leaves paymentStatus untouched (docs/decisions.md #1).
      render: (o) => {
        const label = o.status === "CANCELLED" ? t("status.CANCELLED") : t(`status.${o.paymentStatus}`);
        const tone = o.status === "CANCELLED" ? "danger" : paymentTone(o.paymentStatus);
        return <StatusBadge label={label} tone={tone} />;
      },
    },
    {
      key: "status", header: t("app.status"),
      render: (o) => <StatusBadge label={t(`status.${o.status}`)} tone={statusTone(o.status)} />,
    },
  ];

  const paymentColumns: Column<typeof payments[number]>[] = [
    { key: "date", header: t("purchases.paymentDate"), render: (p) => formatBusinessDate(p.paymentDate, locale) },
    { key: "number", header: t("finance.paymentNumber"), render: (p) => p.paymentNumber },
    { key: "type", header: t("suppliers.statementType"), render: (p) => statementTypeLabel(p.paymentType === "REFUND" ? "REFUND" : "PAYMENT") },
    { key: "account", header: t("finance.accounts"), render: (p) => p.account.name },
    { key: "amount", header: t("purchases.paidAmount"), align: "end", render: (p) => <Money minor={p.amount} locale={locale} currency={ctx.currency} /> },
    { key: "reference", header: t("purchases.referenceNumber"), render: (p) => p.referenceNumber ?? "—" },
  ];

  const returnColumns: Column<typeof returns[number]>[] = [
    { key: "number", header: t("sales.returnNumber"), render: (r) => r.returnNumber },
    {
      key: "order", header: t("sales.orderNumber"),
      render: (r) => (
        <Link href={`/${locale}/sales/${r.salesOrderId}`} className="font-medium text-brand hover:underline">
          {r.salesOrder.salesOrderNumber}
        </Link>
      ),
    },
    { key: "date", header: t("app.date"), render: (r) => formatBusinessDate(r.returnDate, locale) },
    { key: "refund", header: t("sales.refundAmount"), align: "end", render: (r) => <Money minor={r.refundAmount} locale={locale} currency={ctx.currency} /> },
    { key: "reason", header: t("inventory.reason"), render: (r) => r.reason ?? "—" },
  ];

  const statementRows = statement.map((s) => ({ ...s, id: s.id }));
  const statementColumns: Column<typeof statementRows[number]>[] = [
    { key: "date", header: t("suppliers.statementDate"), render: (s) => formatBusinessDate(s.transactionDate, locale) },
    { key: "type", header: t("suppliers.statementType"), render: (s) => statementTypeLabel(s.transactionType) },
    { key: "reference", header: t("suppliers.statementReference"), render: (s) => s.referenceNumber },
    { key: "debit", header: t("suppliers.debit"), align: "end", render: (s) => (s.debitAmount > 0 ? <Money minor={s.debitAmount} locale={locale} currency={ctx.currency} /> : "—") },
    { key: "credit", header: t("suppliers.credit"), align: "end", render: (s) => (s.creditAmount > 0 ? <Money minor={s.creditAmount} locale={locale} currency={ctx.currency} /> : "—") },
    { key: "runningBalance", header: t("suppliers.runningBalance"), align: "end", render: (s) => <Money minor={s.runningBalance} locale={locale} currency={ctx.currency} tone="auto" /> },
  ];

  // Stored as a plain string (no DB enum) — fall back to RETAIL for any
  // value outside the two the create/edit form actually offers, same
  // defensive pattern as createCustomer/updateCustomer's own validation.
  const customerTypeSafe: CustomerType =
    (CUSTOMER_TYPES as readonly string[]).includes(customer.customerType)
      ? (customer.customerType as CustomerType)
      : "RETAIL";

  const typeOptions = Object.fromEntries(
    CUSTOMER_TYPES.map((c) => [c, t(`customers.${c.toLowerCase()}`)]),
  ) as CustomerFormLabels["typeOptions"];

  const editLabels: CustomerFormLabels = {
    customerType: t("customers.type"), typeOptions,
    name: t("suppliers.name"), phone: t("suppliers.phone"), email: t("suppliers.email"),
    country: t("suppliers.country"), city: t("suppliers.city"), address: t("suppliers.address"),
    taxNumber: t("suppliers.taxNumber"), creditLimit: t("customers.creditLimit"),
    paymentTermsDays: t("suppliers.paymentTermsDays"), notes: t("suppliers.notes"),
    save: t("app.save"), cancel: t("app.cancel"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.INVALID_NAME": t("errors.INVALID_NAME"),
      "errors.INVALID_CUSTOMER_TYPE": t("errors.INVALID_CUSTOMER_TYPE"),
      "errors.INVALID_PAYMENT_TERMS": t("errors.INVALID_PAYMENT_TERMS"),
      "errors.INVALID_CREDIT_LIMIT": t("errors.INVALID_CREDIT_LIMIT"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">{customer.name}</h1>
          <p className="text-sm text-muted">
            {[customer.city, customer.country].filter(Boolean).join(", ") || "—"}
            {customer.phone ? ` · ${customer.phone}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge label={t(`status.${customer.status}`)} tone={customer.status === "ACTIVE" ? "success" : "neutral"} />
            <StatusBadge label={typeLabel(customer.customerType)} tone="neutral" />
          </div>
        </div>
        {canEdit ? (
          <CustomerEditSection
            locale={locale}
            customerId={customer.id}
            defaults={{
              customerType: customerTypeSafe,
              name: customer.name, phone: customer.phone ?? "", email: customer.email ?? "",
              country: customer.country ?? "", city: customer.city ?? "", address: customer.address ?? "",
              taxNumber: customer.taxNumber ?? "", creditLimit: String(fromMinor(customer.creditLimit)),
              paymentTermsDays: String(customer.paymentTermsDays), notes: customer.notes ?? "",
            }}
            labels={editLabels}
            editLabel={t("app.edit")}
          />
        ) : null}
      </div>

      <PageSection title={t("suppliers.overview")}>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">{t("customers.outstanding")}</div>
            <div className="mt-1 text-lg font-semibold">
              <Money minor={balance} locale={locale} currency={ctx.currency} tone="auto" />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("customers.totalSales")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={totalSales} locale={locale} currency={ctx.currency} /></div>
            {/*
              Same reasoning as the dashboard's profit footnote (decisions #8):
              say so on screen rather than quietly presenting two numbers on
              different bases. This figure is tax-EXCLUSIVE and live-orders
              only, while the table below lists each order's tax-INCLUSIVE
              grandTotal for every status — so a merchant adding up the visible
              column will not arrive at this total, and without the note that
              reads as a bug rather than a definition.
            */}
            <p className="mt-1 text-xs text-muted">{t("customers.totalSalesFootnote")}</p>
          </div>
          <div>
            <div className="text-xs text-muted">{t("customers.totalOrders")}</div>
            <div className="mt-1 text-lg font-semibold">{formatNumber(salesOrders.length, locale)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("customers.creditLimit")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={customer.creditLimit} locale={locale} currency={ctx.currency} /></div>
          </div>
        </div>
      </PageSection>

      <PageSection title={t("customers.ordersSection")}>
        <DataTable columns={orderColumns} rows={salesOrders} empty={<EmptyState message={t("sales.empty")} />} />
      </PageSection>

      <PageSection title={t("suppliers.paymentsSection")}>
        <DataTable columns={paymentColumns} rows={payments} empty={<EmptyState message={t("purchases.noPayments")} />} />
      </PageSection>

      <PageSection title={t("sales.returnsSection")}>
        <DataTable columns={returnColumns} rows={returns} empty={<EmptyState message={t("sales.noReturns")} />} />
      </PageSection>

      <PageSection title={t("customers.statement")}>
        <DataTable columns={statementColumns} rows={statementRows} empty={<EmptyState message={t("suppliers.statementEmpty")} />} />
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={statementTotal}
          // Omits ?page= for `lastPage` (the default landing page here), not
          // for page 1 — same reversed convention as suppliers/[id]/page.tsx.
          buildHref={(target) => `/${locale}/customers/${customer.id}${target !== lastPage ? `?page=${target}` : ""}`}
          labels={{
            previous: t("app.previous"), next: t("app.next"),
            pageInfo: t("app.pageOf", {
              page: formatNumber(page, locale),
              pages: formatNumber(lastPage, locale),
            }),
          }}
        />
      </PageSection>
    </div>
  );
}

import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { customerBalances, LIVE_ORDER_STATUSES } from "@/services/reporting";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CustomerFilters } from "./CustomerFilters";

// Same page size as the suppliers list (src/app/[locale]/(app)/suppliers/page.tsx).
const PAGE_SIZE = 50;

export default async function CustomersPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "customers.view", locale);
  const t = await getTranslator(locale);

  const canCreate = can(ctx.role, "customers.create");

  const q = typeof sp.q === "string" ? sp.q : "";
  // `?filter=owing` — the dashboard's "customers owe you" KPI links here.
  const owingOnly = sp.filter === "owing";

  const [customers, balances, salesAgg] = await Promise.all([
    prisma.customer.findMany({
      where: {
        companyId: ctx.companyId,
        ...(q ? {
          OR: [
            { name: { contains: q } },
            { phone: { contains: q } },
            { email: { contains: q } },
          ],
        } : {}),
      },
      orderBy: { name: "asc" },
    }),
    // One query for the whole page — never `customerBalance` (a Tx-taking,
    // per-customer reader) fanned out once per row.
    customerBalances(ctx.companyId),
    // LIVE orders only (CONFIRMED/COMPLETED) — `status: { not: "CANCELLED" }`
    // used to admit DRAFT too, and confirmSale deliberately strands a DRAFT
    // order when it throws (e.g. insufficient stock; there's a DRAFT filter
    // on the sales list for exactly this), so a customer whose sale failed
    // repeatedly showed phantom orders here. Same basis as the dashboard's
    // identically-labelled "Total sales" KPI (salesSummary in
    // src/services/reporting.ts): subtotal + shippingCharged -
    // refundedAmount, tax-EXCLUSIVE — this used to be grandTotal -
    // refundedAmount (tax-inclusive), a different number under the same
    // label on two screens (Stage 1B review, IMPORTANT 4).
    prisma.salesOrder.groupBy({
      by: ["customerId"],
      where: { companyId: ctx.companyId, status: { in: LIVE_ORDER_STATUSES }, customerId: { not: null } },
      _sum: { subtotal: true, shippingCharged: true, refundedAmount: true },
      _count: { _all: true },
      _max: { orderDate: true },
    }),
  ]);

  const salesMap = new Map(
    salesAgg.map((row) => [row.customerId as string, {
      total: (row._sum.subtotal ?? 0) + (row._sum.shippingCharged ?? 0) - (row._sum.refundedAmount ?? 0),
      count: row._count._all,
      last: row._max.orderDate,
    }]),
  );

  function typeLabel(customerType: string): string {
    const label = t(`customers.${customerType.toLowerCase()}`);
    return label.startsWith("customers.") ? customerType : label;
  }

  const filteredRows = customers
    .map((c) => ({
      ...c,
      id: c.id,
      balance: balances.get(c.id) ?? 0,
      totalOrders: salesMap.get(c.id)?.count ?? 0,
      totalSales: salesMap.get(c.id)?.total ?? 0,
      lastOrder: salesMap.get(c.id)?.last ?? null,
    }))
    .filter((c) => !owingOnly || c.balance > 0);

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const total = filteredRows.length;
  const rows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "name", header: t("suppliers.name"),
      render: (row) => (
        <Link href={`/${locale}/customers/${row.id}`} className="font-medium text-brand hover:underline">
          {row.name}
        </Link>
      ),
    },
    { key: "phone", header: t("suppliers.phone"), render: (row) => row.phone ?? "—" },
    { key: "type", header: t("customers.type"), render: (row) => typeLabel(row.customerType) },
    { key: "totalOrders", header: t("customers.totalOrders"), align: "end", render: (row) => formatNumber(row.totalOrders, locale) },
    {
      key: "totalSales", header: t("customers.totalSales"), align: "end",
      render: (row) => <Money minor={row.totalSales} locale={locale} currency={ctx.currency} />,
    },
    {
      key: "outstanding", header: t("customers.outstanding"), align: "end",
      render: (row) => <Money minor={row.balance} locale={locale} currency={ctx.currency} tone="auto" />,
    },
    {
      key: "lastOrder", header: t("suppliers.lastOrder"),
      render: (row) => (row.lastOrder ? formatBusinessDate(row.lastOrder, locale) : "—"),
    },
    {
      key: "status", header: t("app.status"),
      render: (row) => <StatusBadge label={t(`status.${row.status}`)} tone={row.status === "ACTIVE" ? "success" : "neutral"} />,
    },
  ];

  return (
    <div>
      {canCreate ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Link
            href={`/${locale}/customers/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("customers.add")}
          </Link>
        </div>
      ) : null}

      <div className="mb-6">
        <PageHelp t={t} pageKey="customers" />
      </div>

      <CustomerFilters
        current={{ q, owing: owingOnly }}
        labels={{ search: t("app.search"), owingOnly: t("customers.owingOnly"), all: t("app.all") }}
      />

      <DataTable
        columns={columns}
        rows={rows}
        empty={
          <EmptyState
            message={t("customers.empty")}
            actionLabel={canCreate ? t("customers.add") : undefined}
            actionHref={canCreate ? `/${locale}/customers/new` : undefined}
          />
        }
      />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => {
          const params = new URLSearchParams();
          if (q) params.set("q", q);
          if (owingOnly) params.set("filter", "owing");
          if (target > 1) params.set("page", String(target));
          const qs = params.toString();
          return `/${locale}/customers${qs ? `?${qs}` : ""}`;
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

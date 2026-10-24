import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { SALES_CHANNELS } from "@/lib/constants";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SalesFilters } from "./SalesFilters";

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

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

// Every sales order the company has ever raised, unbounded, used to load on
// every visit — same paging convention as every other Task 5-9 list.
const PAGE_SIZE = 50;

export default async function SalesPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "sales.view", locale);
  const t = await getTranslator(locale);

  // The net profit column is only rendered for a role with finance.view_profit
  // — a sales employee sees the order without its profit (Task 8 brief).
  const canViewProfit = can(ctx.role, "finance.view_profit");
  const canCreate = can(ctx.role, "sales.create");

  const customerFilter = typeof sp.customer === "string" ? sp.customer : "";
  const channelFilter = typeof sp.channel === "string" ? sp.channel : "";
  const statusFilter = typeof sp.status === "string" ? sp.status : "";
  const paymentStatusFilter = typeof sp.paymentStatus === "string" ? sp.paymentStatus : "";
  const fromFilter = typeof sp.from === "string" && isIsoDay(sp.from) ? sp.from : "";
  const toFilter = typeof sp.to === "string" && isIsoDay(sp.to) ? sp.to : "";

  // Same UTC-day-window convention as purchases/page.tsx — both endpoint
  // days fully included.
  const orderDate = (fromFilter || toFilter) ? {
    ...(fromFilter ? { gte: new Date(`${fromFilter}T00:00:00.000Z`) } : {}),
    ...(toFilter ? { lt: new Date(new Date(`${toFilter}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
  } : undefined;

  // The payment-status filter must ALWAYS exclude CANCELLED orders
  // (docs/decisions.md #1: cancelSale never touches paymentStatus, so a
  // cancelled order's stored paymentStatus is stale) — including when the
  // merchant has ALSO explicitly chosen status=CANCELLED, in which case an
  // explicit status wins outright and paymentStatus is dropped rather than
  // ANDed into a silent zero-row contradiction. Identical rule to
  // purchases/page.tsx.
  const excludeCancelled = statusFilter !== "CANCELLED";
  const applyPaymentStatusFilter = !!paymentStatusFilter && excludeCancelled;

  const where = {
    companyId: ctx.companyId,
    ...(customerFilter ? { customerId: customerFilter } : {}),
    ...(channelFilter ? { channel: channelFilter } : {}),
    ...(statusFilter
      ? { status: statusFilter }
      : paymentStatusFilter ? { status: { not: "CANCELLED" } } : {}),
    ...(applyPaymentStatusFilter ? { paymentStatus: paymentStatusFilter } : {}),
    ...(orderDate ? { orderDate } : {}),
  };

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const [orders, total, customers] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      include: { customer: { select: { name: true } }, warehouse: { select: { name: true } } },
      orderBy: { orderDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.salesOrder.count({ where }),
    prisma.customer.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);

  const rows = orders.map((o) => ({ ...o, id: o.id }));

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "number", header: t("sales.orderNumber"),
      render: (r) => (
        <Link href={`/${locale}/sales/${r.id}`} className="font-medium text-brand hover:underline">
          {r.salesOrderNumber}
        </Link>
      ),
    },
    { key: "customer", header: t("sales.customer"), render: (r) => r.customer?.name ?? t("sales.walkIn") },
    { key: "channel", header: t("sales.channel"), render: (r) => t(`sales.channelOptions.${r.channel}`) },
    { key: "orderDate", header: t("purchases.orderDate"), render: (r) => formatBusinessDate(r.orderDate, locale) },
    {
      key: "total", header: t("purchases.grandTotal"), align: "end",
      render: (r) => <Money minor={r.grandTotal} locale={locale} currency={ctx.currency} />,
    },
    {
      key: "paymentStatus", header: t("purchases.paymentStatus"),
      // Rows with status === CANCELLED render the CANCELLED status label
      // here, never the stored paymentStatus — cancelSale leaves that column
      // untouched (docs/decisions.md #1), same rule as purchases.
      render: (r) => {
        const label = r.status === "CANCELLED" ? t("status.CANCELLED") : t(`status.${r.paymentStatus}`);
        const tone = r.status === "CANCELLED" ? "danger" : paymentTone(r.paymentStatus);
        return <StatusBadge label={label} tone={tone} />;
      },
    },
    {
      key: "status", header: t("app.status"),
      render: (r) => <StatusBadge label={t(`status.${r.status}`)} tone={statusTone(r.status)} />,
    },
    ...(canViewProfit ? [{
      key: "netProfit", header: t("sales.profit"), align: "end" as const,
      render: (r: typeof rows[number]) => <Money minor={r.netProfit} locale={locale} currency={ctx.currency} tone="auto" />,
    }] : []),
    { key: "warehouse", header: t("purchases.warehouse"), render: (r) => r.warehouse.name },
  ];

  const channelOptions = Object.fromEntries(
    SALES_CHANNELS.map((c) => [c, t(`sales.channelOptions.${c}`)]),
  ) as Record<typeof SALES_CHANNELS[number], string>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        {/* A plain link: the route gates itself (403 without sales.view) and
            drops the profit columns for a role that may not see them. */}
        <a href={`/${locale}/export/sales`} className="rounded-lg border border-line px-4 py-2 text-sm text-navy">
          {t("app.exportCsv")}
        </a>
        {canCreate ? (
          <Link
            href={`/${locale}/sales/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("sales.add")}
          </Link>
        ) : null}
      </div>

      <div className="mb-4">
        <PageHelp t={t} pageKey="sales" />
      </div>

      <SalesFilters
        customers={customers.map((c) => ({ id: c.id, label: c.name }))}
        current={{
          customer: customerFilter, channel: channelFilter,
          status: statusFilter, paymentStatus: paymentStatusFilter,
          from: fromFilter, to: toFilter,
        }}
        labels={{
          customer: t("sales.customer"), channel: t("sales.channel"),
          status: t("app.status"), paymentStatus: t("purchases.paymentStatus"),
          dateFrom: t("inventory.dateFrom"), dateTo: t("inventory.dateTo"), all: t("app.all"),
          draft: t("status.DRAFT"), confirmed: t("status.CONFIRMED"), cancelled: t("status.CANCELLED"),
          unpaid: t("status.UNPAID"), partial: t("status.PARTIAL"), paid: t("status.PAID"),
          channelOptions,
        }}
      />

      <DataTable columns={columns} rows={rows} empty={
          <EmptyState
            message={t("sales.empty")}
            actionLabel={canCreate ? t("sales.add") : undefined}
            actionHref={canCreate ? `/${locale}/sales/new` : undefined}
          />
        } />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => {
          const params = new URLSearchParams();
          if (customerFilter) params.set("customer", customerFilter);
          if (channelFilter) params.set("channel", channelFilter);
          if (statusFilter) params.set("status", statusFilter);
          // Same `applyPaymentStatusFilter` gate the `where` clause above
          // uses — status=CANCELLED drops paymentStatus server-side, so a
          // page link must not resurrect it in the query string either.
          if (applyPaymentStatusFilter) params.set("paymentStatus", paymentStatusFilter);
          if (fromFilter) params.set("from", fromFilter);
          if (toFilter) params.set("to", toFilter);
          if (target > 1) params.set("page", String(target));
          const qs = params.toString();
          return `/${locale}/sales${qs ? `?${qs}` : ""}`;
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

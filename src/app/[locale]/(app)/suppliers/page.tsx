import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { supplierBalances } from "@/services/reporting";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SupplierFilters } from "./SupplierFilters";

// Same page size as the purchases list (src/app/[locale]/(app)/purchases/page.tsx).
// Paginated in-memory (slice), not via Prisma skip/take: `?filter=owing` is a
// derived filter over `supplierBalances` (a balance, not a DB column), so the
// owing/non-owing set can only be known after that lookup runs — DB-level
// pagination applied before it would slice an inconsistent, filter-order-
// dependent page.
const PAGE_SIZE = 50;

export default async function SuppliersPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "suppliers.view", locale);
  const t = await getTranslator(locale);

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canCreate = can(ctx.role, "suppliers.create");

  const q = typeof sp.q === "string" ? sp.q : "";
  // `?filter=owing` — the dashboard's "you owe suppliers" KPI links here to
  // show only suppliers the company currently owes money to.
  const owingOnly = sp.filter === "owing";

  const [suppliers, balances, purchaseAgg] = await Promise.all([
    prisma.supplier.findMany({
      where: {
        companyId: ctx.companyId,
        ...(q ? {
          OR: [
            { name: { contains: q } },
            { companyName: { contains: q } },
            { phone: { contains: q } },
          ],
        } : {}),
      },
      orderBy: { name: "asc" },
    }),
    // One query for the whole page — never `supplierBalance` (a Tx-taking,
    // per-supplier reader) fanned out once per row.
    supplierBalances(ctx.companyId),
    // Cancelled orders never contributed goods value (cancelPurchaseOrder
    // only allows cancelling before anything is received), so they are
    // excluded from "total purchases" the same way LIVE_ORDER_STATUSES
    // excludes cancelled sales orders from revenue.
    prisma.purchaseOrder.groupBy({
      by: ["supplierId"],
      where: { companyId: ctx.companyId, status: { not: "CANCELLED" } },
      _sum: { grandTotal: true },
      _max: { orderDate: true },
    }),
  ]);

  const purchaseMap = new Map(
    purchaseAgg.map((row) => [row.supplierId, { total: row._sum.grandTotal ?? 0, last: row._max.orderDate }]),
  );

  const filteredRows = suppliers
    .map((s) => ({
      ...s,
      id: s.id,
      balance: balances.get(s.id) ?? 0,
      totalPurchases: purchaseMap.get(s.id)?.total ?? 0,
      lastOrder: purchaseMap.get(s.id)?.last ?? null,
    }))
    .filter((s) => !owingOnly || s.balance > 0);

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const total = filteredRows.length;
  const rows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "name", header: t("suppliers.name"),
      render: (row) => (
        <Link href={`/${locale}/suppliers/${row.id}`} className="font-medium text-brand hover:underline">
          {row.name}
        </Link>
      ),
    },
    { key: "country", header: t("suppliers.country"), render: (row) => row.country ?? "—" },
    { key: "phone", header: t("suppliers.phone"), render: (row) => row.phone ?? "—" },
    ...(canViewCost ? [{
      key: "balance", header: t("suppliers.balance"), align: "end" as const,
      render: (row: typeof rows[number]) => (
        <Money minor={row.balance} locale={locale} currency={ctx.currency} tone="auto" />
      ),
    }, {
      key: "totalPurchases", header: t("suppliers.totalPurchases"), align: "end" as const,
      render: (row: typeof rows[number]) => (
        <Money minor={row.totalPurchases} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
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
            href={`/${locale}/suppliers/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("suppliers.add")}
          </Link>
        </div>
      ) : null}

      <div className="mb-6">
        <PageHelp t={t} pageKey="suppliers" />
      </div>

      <SupplierFilters
        current={{ q, owing: owingOnly }}
        labels={{ search: t("app.search"), owingOnly: t("suppliers.owingOnly"), all: t("app.all") }}
      />

      <DataTable
        columns={columns}
        rows={rows}
        empty={
          <EmptyState
            message={t("suppliers.empty")}
            actionLabel={canCreate ? t("suppliers.add") : undefined}
            actionHref={canCreate ? `/${locale}/suppliers/new` : undefined}
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
          return `/${locale}/suppliers${qs ? `?${qs}` : ""}`;
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

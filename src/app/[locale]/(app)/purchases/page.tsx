import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PurchaseFilters } from "./PurchaseFilters";

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

// Every purchase order the company has ever raised, unbounded, used to load
// on every visit — same paging convention as every other Task 5-9 list.
const PAGE_SIZE = 50;

export default async function PurchasesPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "purchases.view", locale);
  const t = await getTranslator(locale);

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canCreate = can(ctx.role, "purchases.create");

  const supplierFilter = typeof sp.supplier === "string" ? sp.supplier : "";
  const warehouseFilter = typeof sp.warehouse === "string" ? sp.warehouse : "";
  const statusFilter = typeof sp.status === "string" ? sp.status : "";
  const paymentStatusFilter = typeof sp.paymentStatus === "string" ? sp.paymentStatus : "";
  const fromFilter = typeof sp.from === "string" && isIsoDay(sp.from) ? sp.from : "";
  const toFilter = typeof sp.to === "string" && isIsoDay(sp.to) ? sp.to : "";

  // Same UTC-day-window convention as inventory/movements/page.tsx — both
  // endpoint days fully included.
  const orderDate = (fromFilter || toFilter) ? {
    ...(fromFilter ? { gte: new Date(`${fromFilter}T00:00:00.000Z`) } : {}),
    ...(toFilter ? { lt: new Date(new Date(`${toFilter}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
  } : undefined;

  // The payment-status filter must ALWAYS exclude CANCELLED orders
  // (docs/decisions.md #1: cancelPurchaseOrder never touches paymentStatus,
  // so a cancelled order's stored paymentStatus is stale and filtering by it
  // is meaningless) — including when the merchant has ALSO explicitly chosen
  // status=CANCELLED. Rather than AND both literally (status:"CANCELLED" AND
  // status:{not:"CANCELLED"}, which would just return zero rows with no
  // indication why), an explicit status=CANCELLED wins outright and the
  // paymentStatus filter is dropped for that request: a merchant looking at
  // cancelled orders has already opted out of "what's still owed" framing,
  // so silently ignoring a paymentStatus param that can't apply to that view
  // is the more useful reading than a mysteriously empty list.
  const excludeCancelled = statusFilter !== "CANCELLED";
  const applyPaymentStatusFilter = !!paymentStatusFilter && excludeCancelled;

  const where = {
    companyId: ctx.companyId,
    ...(supplierFilter ? { supplierId: supplierFilter } : {}),
    ...(warehouseFilter ? { warehouseId: warehouseFilter } : {}),
    ...(statusFilter
      ? { status: statusFilter }
      : paymentStatusFilter ? { status: { not: "CANCELLED" } } : {}),
    ...(applyPaymentStatusFilter ? { paymentStatus: paymentStatusFilter } : {}),
    ...(orderDate ? { orderDate } : {}),
  };

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const [orders, total, suppliers, warehouses] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { name: true } } },
      orderBy: { orderDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.purchaseOrder.count({ where }),
    prisma.supplier.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    prisma.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);

  const rows = orders.map((o) => ({ ...o, id: o.id }));

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "number", header: t("purchases.title"),
      render: (r) => (
        <Link href={`/${locale}/purchases/${r.id}`} className="font-medium text-brand hover:underline">
          {r.purchaseOrderNumber}
        </Link>
      ),
    },
    { key: "supplier", header: t("purchases.supplier"), render: (r) => r.supplier.name },
    { key: "orderDate", header: t("purchases.orderDate"), render: (r) => formatBusinessDate(r.orderDate, locale) },
    {
      key: "expectedDate", header: t("purchases.expectedDate"),
      render: (r) => (r.expectedDate ? formatBusinessDate(r.expectedDate, locale) : "—"),
    },
    ...(canViewCost ? [{
      key: "total", header: t("purchases.grandTotal"), align: "end" as const,
      render: (r: typeof rows[number]) => <Money minor={r.grandTotal} locale={locale} currency={ctx.currency} />,
    }] : []),
    {
      key: "paymentStatus", header: t("purchases.paymentStatus"),
      // Rows with status === CANCELLED render the CANCELLED status label
      // here, never the stored paymentStatus — cancelPurchaseOrder leaves
      // that column untouched (docs/decisions.md #1).
      render: (r) => {
        const label = r.status === "CANCELLED" ? t("status.CANCELLED") : t(`status.${r.paymentStatus}`);
        const tone = r.status === "CANCELLED" ? "danger" : paymentTone(r.paymentStatus);
        return <StatusBadge label={label} tone={tone} />;
      },
    },
    {
      // A distinct dictionary namespace from `status.*` — receivingStatus's
      // own PARTIAL value would otherwise collide with paymentStatus's
      // identically-named PARTIAL member and render "Partially paid" in a
      // column that has nothing to do with payment.
      key: "receivingStatus", header: t("purchases.receivingStatus"),
      render: (r) => <StatusBadge label={t(`purchases.receivingStatusOptions.${r.receivingStatus}`)} tone={r.receivingStatus === "RECEIVED" ? "success" : r.receivingStatus === "PARTIAL" ? "warning" : "neutral"} />,
    },
    {
      key: "status", header: t("app.status"),
      render: (r) => <StatusBadge label={t(`status.${r.status}`)} tone={statusTone(r.status)} />,
    },
  ];

  return (
    <div>
      {canCreate ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Link
            href={`/${locale}/purchases/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("purchases.add")}
          </Link>
        </div>
      ) : null}

      <div className="mb-4">
        <PageHelp t={t} pageKey="purchases" />
      </div>

      <PurchaseFilters
        suppliers={suppliers.map((s) => ({ id: s.id, label: s.name }))}
        warehouses={warehouses.map((w) => ({ id: w.id, label: w.name }))}
        current={{
          supplier: supplierFilter, warehouse: warehouseFilter,
          status: statusFilter, paymentStatus: paymentStatusFilter,
          from: fromFilter, to: toFilter,
        }}
        labels={{
          supplier: t("purchases.supplier"), warehouse: t("purchases.warehouse"),
          status: t("app.status"), paymentStatus: t("purchases.paymentStatus"),
          dateFrom: t("inventory.dateFrom"), dateTo: t("inventory.dateTo"), all: t("app.all"),
          draft: t("status.DRAFT"), confirmed: t("status.CONFIRMED"), cancelled: t("status.CANCELLED"),
          unpaid: t("status.UNPAID"), partial: t("status.PARTIAL"), paid: t("status.PAID"),
        }}
      />

      <DataTable columns={columns} rows={rows} empty={
          <EmptyState
            message={t("purchases.empty")}
            actionLabel={canCreate ? t("purchases.add") : undefined}
            actionHref={canCreate ? `/${locale}/purchases/new` : undefined}
          />
        } />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => {
          const params = new URLSearchParams();
          if (supplierFilter) params.set("supplier", supplierFilter);
          if (warehouseFilter) params.set("warehouse", warehouseFilter);
          if (statusFilter) params.set("status", statusFilter);
          // Same `applyPaymentStatusFilter` gate the `where` clause above
          // uses — status=CANCELLED drops paymentStatus server-side, so a
          // page-2/page-1 link must not resurrect it in the query string
          // either (see PurchaseFilters.tsx's matching disabled-select note).
          if (applyPaymentStatusFilter) params.set("paymentStatus", paymentStatusFilter);
          if (fromFilter) params.set("from", fromFilter);
          if (toFilter) params.set("to", toFilter);
          if (target > 1) params.set("page", String(target));
          const qs = params.toString();
          return `/${locale}/purchases${qs ? `?${qs}` : ""}`;
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

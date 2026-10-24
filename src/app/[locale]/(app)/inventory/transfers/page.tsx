import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatQty, formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { InventoryNav } from "../InventoryNav";

// Every transfer the company has ever shipped, unbounded, used to load on
// every visit. Paged like any other server-rendered list, not `take`-capped
// with no way to see the rest.
const PAGE_SIZE = 50;

export default async function TransfersPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  // A read: the transfers LIST is inventory data like the balances/movements
  // pages, gated on `inventory.view`. Only the receive-transfer PAGE (and
  // the "receive" link below) needs the stricter `inventory.transfer`.
  requirePermission(ctx, "inventory.view", locale);
  const t = await getTranslator(locale);

  const canReceive = can(ctx.role, "inventory.transfer");

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const where = { companyId: ctx.companyId };
  const [transfers, total] = await Promise.all([
    prisma.warehouseTransfer.findMany({
      where,
      include: {
        source: { select: { name: true } },
        destination: { select: { name: true } },
        items: { select: { shippedQty: true } },
      },
      orderBy: { transferDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.warehouseTransfer.count({ where }),
  ]);

  const rows = transfers.map((tr) => ({
    ...tr,
    id: tr.id,
    units: tr.items.reduce((s, i) => s + i.shippedQty, 0),
  }));

  const statusTone = (status: string) => (
    status === "IN_TRANSIT" ? "warning" : status === "RECEIVED" ? "success" : "neutral"
  );

  const columns: Column<typeof rows[number]>[] = [
    { key: "number", header: t("inventory.transferNumber"), render: (r) => r.transferNumber },
    { key: "date", header: t("app.date"), render: (r) => formatBusinessDate(r.transferDate, locale) },
    { key: "source", header: t("inventory.from"), render: (r) => r.source.name },
    { key: "destination", header: t("inventory.to"), render: (r) => r.destination.name },
    { key: "units", header: t("warehouses.totalUnits"), align: "end", render: (r) => formatQty(r.units, locale) },
    {
      key: "status", header: t("app.status"),
      render: (r) => <StatusBadge label={t(`status.${r.status}`)} tone={statusTone(r.status)} />,
    },
    {
      key: "actions", header: "", align: "end",
      render: (r) => (
        canReceive && r.status === "IN_TRANSIT" ? (
          <Link
            href={`/${locale}/inventory/transfers/${r.id}/receive`}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-brand hover:bg-surface"
          >
            {t("inventory.receiveTransfer")}
          </Link>
        ) : null
      ),
    },
  ];

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-navy">{t("inventory.transfersTitle")}</h1>
      <InventoryNav locale={locale} role={ctx.role} t={t} active="transfers" />

      <DataTable columns={columns} rows={rows} empty={
          <EmptyState
            message={t("inventory.transfersEmpty")}
            actionLabel={canReceive ? t("inventory.transfer") : undefined}
            actionHref={canReceive ? `/${locale}/inventory/transfer` : undefined}
          />
        } />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => `/${locale}/inventory/transfers${target > 1 ? `?page=${target}` : ""}`}
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

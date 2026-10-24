import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { InventoryNav } from "../InventoryNav";

// Same page-based convention as transfers/page.tsx: every count session the
// company has ever run, paged, not `take`-capped with no way to see the rest.
const PAGE_SIZE = 50;

export default async function StockCountsPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  // Unlike transfers, stock counts have no separate "view" permission —
  // inventory.count gates both seeing the list and starting a count.
  // requirePermission redirects rather than returning, so everything below
  // this line runs only for a role that already holds inventory.count. A
  // second can(ctx.role, "inventory.count") to gate the "Start a count"
  // button would be the same pure function on the same inputs a few lines
  // later — it can never be false, and a bug in can() would break both
  // checks identically. So the button is rendered unconditionally and this
  // one gate governs the whole page.
  requirePermission(ctx, "inventory.count", locale);
  const t = await getTranslator(locale);

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const where = { companyId: ctx.companyId };
  const [sessions, total, countedGroups] = await Promise.all([
    prisma.stockCountSession.findMany({
      where,
      include: { warehouse: { select: { name: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.stockCountSession.count({ where }),
    // Counted-line totals for the whole page in ONE query, not one query per
    // row — a groupBy over every counted line this tenant owns, keyed by
    // session. countedQty is nullable ("nobody counted this line yet"), so
    // only non-null rows count toward progress.
    prisma.stockCountLine.groupBy({
      by: ["sessionId"],
      where: { companyId: ctx.companyId, countedQty: { not: null } },
      _count: true,
    }),
  ]);

  const countedBySession = new Map(countedGroups.map((g) => [g.sessionId, g._count]));

  const scopeLabel = (scopeType: string) =>
    scopeType === "CATEGORY" ? t("counts.scopeCategory")
      : scopeType === "BRAND" ? t("counts.scopeBrand")
      : scopeType === "MANUAL" ? t("counts.scopeManual")
      : t("counts.scopeWarehouse");

  const statusTone = (status: string) =>
    status === "POSTED" ? "success" : status === "REVIEW" ? "warning" : status === "CANCELLED" ? "danger" : "neutral";

  const columns: Column<typeof sessions[number]>[] = [
    {
      key: "countNumber", header: t("counts.countNumber"),
      render: (s) => (
        // OPEN sessions still take counting entries (Task 8); anything past
        // OPEN is read-only and belongs on the review screen (Task 9).
        // Neither route exists yet — that is expected for this task.
        <Link
          href={`/${locale}/inventory/counts/${s.id}${s.status === "OPEN" ? "" : "/review"}`}
          className="font-medium text-brand hover:underline"
        >
          {s.countNumber}
        </Link>
      ),
    },
    { key: "warehouse", header: t("counts.warehouse"), render: (s) => s.warehouse.name },
    { key: "scope", header: t("counts.scope"), render: (s) => scopeLabel(s.scopeType) },
    {
      key: "status", header: t("app.status"),
      render: (s) => <StatusBadge label={t(`status.${s.status}`)} tone={statusTone(s.status)} />,
    },
    {
      key: "progress", header: t("counts.progress"), align: "end",
      render: (s) => `${formatNumber(countedBySession.get(s.id) ?? 0, locale)} / ${formatNumber(s._count.lines, locale)}`,
    },
    { key: "date", header: t("app.date"), render: (s) => formatBusinessDate(s.createdAt, locale) },
  ];

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-navy">{t("counts.title")}</h1>
      <InventoryNav locale={locale} role={ctx.role} t={t} active="counts" />

      <div className="mb-4 flex justify-end">
        <Link
          href={`/${locale}/inventory/counts/new`}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink"
        >
          {t("counts.add")}
        </Link>
      </div>

      <DataTable columns={columns} rows={sessions} empty={
          <EmptyState
            message={t("counts.empty")}
            actionLabel={t("counts.add")}
            actionHref={`/${locale}/inventory/counts/new`}
          />
        } />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => `/${locale}/inventory/counts${target > 1 ? `?page=${target}` : ""}`}
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

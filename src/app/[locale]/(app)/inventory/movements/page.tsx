import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { MOVEMENT_TYPES } from "@/lib/constants";
import { fromCost } from "@/lib/money";
import { formatQty, formatBusinessDateTime, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { InventoryNav } from "../InventoryNav";
import { MovementFilters } from "./MovementFilters";

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Every movement the company has ever recorded, unbounded, used to load on
// every visit — a long-lived tenant's movement history only grows. Paged
// like any other server-rendered list here, not `take`-capped with no way
// to see the rest.
const PAGE_SIZE = 50;

export default async function MovementsPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.view", locale);
  const t = await getTranslator(locale);

  const warehouseFilter = typeof sp.warehouse === "string" ? sp.warehouse : "";
  const productFilter = typeof sp.product === "string" ? sp.product : "";
  const typeFilter = typeof sp.type === "string" ? sp.type : "";
  const fromFilter = typeof sp.from === "string" && isIsoDay(sp.from) ? sp.from : "";
  const toFilter = typeof sp.to === "string" && isIsoDay(sp.to) ? sp.to : "";

  const canViewCost = can(ctx.role, "finance.view_cost");

  // Both endpoint days fully included — same UTC-day-window convention as
  // services/reporting.ts's `dayWindow` (the "to" day's upper bound is the
  // START of the NEXT day, not 23:59:59 of the same one).
  const movementDate = (fromFilter || toFilter) ? {
    ...(fromFilter ? { gte: new Date(`${fromFilter}T00:00:00.000Z`) } : {}),
    ...(toFilter ? { lt: new Date(new Date(`${toFilter}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
  } : undefined;

  const where = {
    companyId: ctx.companyId,
    ...(warehouseFilter ? { warehouseId: warehouseFilter } : {}),
    ...(productFilter ? { productId: productFilter } : {}),
    ...(typeFilter ? { movementType: typeFilter } : {}),
    ...(movementDate ? { movementDate } : {}),
  };

  const rawPage = typeof sp.page === "string" ? Number(sp.page) : 1;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const [movements, total, warehouses, products] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      include: {
        warehouse: { select: { name: true } },
        product: { select: { nameAr: true, nameEn: true, sku: true } },
      },
      orderBy: { movementDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.inventoryMovement.count({ where }),
    prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({
      where: { companyId: ctx.companyId },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameEn: "asc" },
    }),
  ]);

  // InventoryMovement.createdById has no Prisma relation to User (a plain
  // string field, matching every other createdById column in this schema),
  // so the "recorded by" name is a separate lookup, not an `include`.
  const userIds = [...new Set(movements.map((m) => m.createdById).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.fullName]));

  const rows = movements.map((m) => ({ ...m, id: m.id }));

  const columns: Column<typeof rows[number]>[] = [
    // Several movements can land on the same UTC day (a receive and an issue
    // in the same shift) — formatBusinessDateTime (not the date-only
    // formatBusinessDate) so they stay distinguishable by time, same UTC pin
    // either way.
    { key: "date", header: t("app.date"), render: (m) => formatBusinessDateTime(m.movementDate, locale) },
    {
      key: "product", header: t("dashboard.product"),
      render: (m) => (locale === "ar" ? m.product.nameAr : m.product.nameEn),
    },
    { key: "type", header: t("inventory.movementType"), render: (m) => t(`movement.${m.movementType}`) },
    {
      key: "direction", header: t("inventory.direction"),
      render: (m) => (
        <span className={m.direction === "IN" ? "text-success" : "text-danger"}>
          {t(m.direction === "IN" ? "inventory.directionIn" : "inventory.directionOut")}
        </span>
      ),
    },
    {
      key: "quantity", header: t("inventory.quantity"), align: "end",
      render: (m) => formatQty(m.quantity, locale),
    },
    ...(canViewCost ? [{
      key: "unitCost", header: t("inventory.unitCost"), align: "end" as const,
      render: (m: typeof rows[number]) => (
        <Money minor={Math.round(fromCost(m.unitCost))} locale={locale} currency={ctx.currency} />
      ),
    }, {
      key: "totalCost", header: t("inventory.totalCost"), align: "end" as const,
      render: (m: typeof rows[number]) => (
        <Money minor={m.totalCost} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
    { key: "warehouse", header: t("inventory.warehouse"), render: (m) => m.warehouse.name },
    { key: "reference", header: t("products.reference"), render: (m) => m.referenceNumber },
    {
      key: "user", header: t("inventory.recordedBy"),
      render: (m) => (m.createdById ? (userMap.get(m.createdById) ?? "—") : "—"),
    },
  ];

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-navy">{t("inventory.movements")}</h1>
      <InventoryNav locale={locale} role={ctx.role} t={t} active="movements" />

      <MovementFilters
        warehouses={warehouses.map((w) => ({ id: w.id, label: w.name }))}
        products={products.map((p) => ({ id: p.id, label: locale === "ar" ? p.nameAr : p.nameEn }))}
        types={MOVEMENT_TYPES.map((mt) => ({ id: mt, label: t(`movement.${mt}`) }))}
        current={{
          warehouse: warehouseFilter, product: productFilter, type: typeFilter,
          from: fromFilter, to: toFilter,
        }}
        labels={{
          warehouse: t("inventory.warehouse"), product: t("dashboard.product"),
          movementType: t("inventory.movementType"), dateFrom: t("inventory.dateFrom"),
          dateTo: t("inventory.dateTo"), all: t("app.all"),
        }}
      />

      <DataTable columns={columns} rows={rows} empty={<EmptyState message={t("inventory.empty")} />} />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(target) => {
          const params = new URLSearchParams();
          if (warehouseFilter) params.set("warehouse", warehouseFilter);
          if (productFilter) params.set("product", productFilter);
          if (typeFilter) params.set("type", typeFilter);
          if (fromFilter) params.set("from", fromFilter);
          if (toFilter) params.set("to", toFilter);
          if (target > 1) params.set("page", String(target));
          const qs = params.toString();
          return `/${locale}/inventory/movements${qs ? `?${qs}` : ""}`;
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

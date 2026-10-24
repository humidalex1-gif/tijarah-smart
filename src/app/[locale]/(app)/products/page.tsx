import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { PageHelp } from "@/components/ui/PageHelp";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { productStockSummary } from "@/services/reporting";
import { fromCost } from "@/lib/money";
import { formatQty, formatDate, formatPct } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ProductFilters } from "./ProductFilters";

type StockFilter = "in" | "low" | "out" | "";

function stockKind(availableQty: number, reorderLevel: number): "in" | "low" | "out" {
  if (availableQty <= 0) return "out";
  if (reorderLevel > 0 && availableQty <= reorderLevel) return "low";
  return "in";
}

export default async function ProductsPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "products.view", locale);
  const t = await getTranslator(locale);

  const q = typeof sp.q === "string" ? sp.q : "";
  const categoryFilter = typeof sp.category === "string" ? sp.category : "";
  const brandFilter = typeof sp.brand === "string" ? sp.brand : "";
  const stockFilter: StockFilter = (typeof sp.stock === "string" ? sp.stock : "") as StockFilter;
  const statusFilter = typeof sp.status === "string" ? sp.status : "";

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canViewMargin = canViewCost && can(ctx.role, "finance.view_profit");

  const [products, categories, brands] = await Promise.all([
    prisma.product.findMany({
      where: {
        companyId: ctx.companyId,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        ...(brandFilter ? { brandId: brandFilter } : {}),
        ...(q ? {
          OR: [
            { nameAr: { contains: q } },
            { nameEn: { contains: q } },
            { sku: { contains: q } },
            { barcode: { contains: q } },
          ],
        } : {}),
      },
      include: { category: true, brand: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.productCategory.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { nameEn: "asc" },
    }),
    prisma.brand.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const stockMap = await productStockSummary(ctx.companyId, products.map((p) => p.id));

  const rows = products
    .map((p) => {
      const stock = stockMap.get(p.id) ?? { availableQty: 0, reservedQty: 0, avgCost: 0, inventoryValue: 0 };
      const kind = stockKind(stock.availableQty, p.reorderLevel);
      // Gated on having an actual cost basis (some stock ever received), not
      // just a selling price — a brand-new product with zero stock and zero
      // avgCost would otherwise read as a misleading 100% margin.
      const marginPct = p.sellingPrice > 0 && stock.availableQty > 0
        ? Math.round(((p.sellingPrice - fromCost(stock.avgCost)) / p.sellingPrice) * 10_000)
        : null;
      return { ...p, id: p.id, stock, kind, marginPct };
    })
    .filter((row) => !stockFilter || row.kind === stockFilter);

  const columns: Column<typeof rows[number]>[] = [
    {
      key: "name", header: t("dashboard.product"),
      render: (row) => (
        <Link href={`/${locale}/products/${row.id}`} className="font-medium text-brand hover:underline">
          {locale === "ar" ? row.nameAr : row.nameEn}
        </Link>
      ),
    },
    { key: "sku", header: t("products.sku"), render: (row) => row.sku },
    { key: "barcode", header: t("products.barcode"), render: (row) => row.barcode ?? "—" },
    {
      key: "category", header: t("products.category"),
      render: (row) => (row.category ? (locale === "ar" ? row.category.nameAr : row.category.nameEn) : "—"),
    },
    { key: "brand", header: t("products.brand"), render: (row) => row.brand?.name ?? "—" },
    {
      key: "available", header: t("products.available"), align: "end",
      render: (row) => formatQty(row.stock.availableQty, locale),
    },
    ...(canViewCost ? [{
      key: "avgCost", header: t("products.avgCost"), align: "end" as const,
      render: (row: typeof rows[number]) => (
        <Money minor={Math.round(fromCost(row.stock.avgCost))} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
    {
      key: "sellingPrice", header: t("products.sellingPrice"), align: "end",
      render: (row) => <Money minor={row.sellingPrice} locale={locale} currency={ctx.currency} />,
    },
    ...(canViewMargin ? [{
      key: "margin", header: t("products.margin"), align: "end" as const,
      render: (row: typeof rows[number]) => (row.marginPct !== null ? formatPct(row.marginPct, locale) : "—"),
    }] : []),
    {
      key: "status", header: t("app.status"),
      render: (row) => (
        <StatusBadge
          label={t(`status.${row.status}`)}
          tone={row.status === "ACTIVE" ? "success" : "neutral"}
        />
      ),
    },
    {
      key: "updatedAt", header: t("products.lastUpdated"),
      render: (row) => formatDate(row.updatedAt, locale),
    },
  ];

  const categoryOptions = categories.map((c) => ({
    id: c.id, label: locale === "ar" ? c.nameAr : c.nameEn,
  }));
  const brandOptions = brands.map((b) => ({ id: b.id, label: b.name }));

  return (
    <div>
      {can(ctx.role, "products.create") ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Link
            href={`/${locale}/products/new`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("products.add")}
          </Link>
        </div>
      ) : null}

      <div className="mb-4">
        <PageHelp t={t} pageKey="products" />
      </div>

      <ProductFilters
        categories={categoryOptions}
        brands={brandOptions}
        current={{ q, category: categoryFilter, brand: brandFilter, stock: stockFilter, status: statusFilter }}
        labels={{
          search: t("app.search"),
          category: t("products.category"),
          brand: t("products.brand"),
          stockStatus: t("products.stockStatus"),
          status: t("app.status"),
          all: t("app.all"),
          inStock: t("status.inStock"),
          lowStock: t("status.lowStock"),
          outOfStock: t("status.outOfStock"),
          active: t("status.ACTIVE"),
          archived: t("status.ARCHIVED"),
        }}
      />

      <DataTable
        columns={columns}
        rows={rows}
        empty={
          <EmptyState
            message={t("products.empty")}
            actionLabel={can(ctx.role, "products.create") ? t("products.add") : undefined}
            actionHref={can(ctx.role, "products.create") ? `/${locale}/products/new` : undefined}
          />
        }
      />
    </div>
  );
}

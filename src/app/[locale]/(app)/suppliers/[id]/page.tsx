import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { supplierBalance } from "@/services/ledger";
import { formatBusinessDate, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SupplierEditSection } from "./SupplierEditSection";
import type { SupplierFormLabels } from "../SupplierForm";

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

// Same page size as the purchases list (src/app/[locale]/(app)/purchases/page.tsx)
// — a long-lived supplier's ledger only grows, so the statement paginates
// like every other unbounded Task 5-9 list rather than rendering every row
// on every visit.
const PAGE_SIZE = 50;

export default async function SupplierDetailPage({
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
  requirePermission(ctx, "suppliers.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter —
  // same tenant-boundary rule as every other Task 5-9 detail page.
  const supplier = await prisma.supplier.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!supplier) notFound();

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canEdit = can(ctx.role, "suppliers.edit");

  // t() returns the bare key on a miss (src/lib/i18n.ts), so an unrecognized
  // transactionType still shows something on screen rather than a raw
  // "suppliers.statementTypeOptions.X" string.
  function statementTypeLabel(transactionType: string): string {
    const label = t(`suppliers.statementTypeOptions.${transactionType}`);
    return label.startsWith("suppliers.statementTypeOptions.") ? transactionType : label;
  }

  const statementWhere = { supplierId: supplier.id, companyId: ctx.companyId };

  const [balance, purchaseOrders, payments, statementTotal] = await Promise.all([
    supplierBalance(prisma, ctx.companyId, supplier.id),
    prisma.purchaseOrder.findMany({
      where: { supplierId: supplier.id, companyId: ctx.companyId },
      orderBy: { orderDate: "desc" },
    }),
    prisma.payment.findMany({
      where: { supplierId: supplier.id, companyId: ctx.companyId },
      include: { account: { select: { name: true } } },
      orderBy: { paymentDate: "desc" },
    }),
    prisma.supplierLedgerEntry.count({ where: statementWhere }),
  ]);

  // The statement is ordered oldest-first (see the query below) so the
  // running balance reads top-to-bottom in the order it actually
  // accumulated — the opposite of the purchase-orders/payments tables above,
  // which are newest-first. With no explicit `?page=`, page 1 of an
  // ascending list would be the OLDEST 50 rows, burying current activity on
  // the LAST page — default to the last page instead so the statement opens
  // on the merchant's most recent activity, matching what "opening a
  // statement" means everywhere else on this screen.
  const lastPage = Math.max(1, Math.ceil(statementTotal / PAGE_SIZE));
  // Clamped, not used raw — an out-of-range `?page=` (typed in directly, or
  // left stale in a bookmark/link after the statement shrinks) would
  // otherwise `skip` past every row and silently render an empty table
  // instead of the nearest real page — same pattern customers/[id]/page.tsx
  // already uses (Stage 1B review, minors).
  const page = Math.min(requestedPage ?? lastPage, lastPage);

  // Ordered by createdAt, matching the insertion order appendSupplierLedger
  // (src/services/ledger.ts) actually computed each row's runningBalance
  // against — transactionDate can theoretically tie or drift from insertion
  // order, but runningBalance never does. Each row already carries its own
  // correct runningBalance snapshot, so paginating this (skip/take) is safe
  // — nothing needs to be recomputed across pages.
  const statement = await prisma.supplierLedgerEntry.findMany({
    where: statementWhere,
    orderBy: { createdAt: "asc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // Cancelled orders never contributed goods value (cancelPurchaseOrder only
  // allows cancelling before anything is received) — same exclusion as the
  // suppliers list page's "total purchases" column.
  const totalPurchases = purchaseOrders
    .filter((po) => po.status !== "CANCELLED")
    .reduce((s, po) => s + po.grandTotal, 0);

  const poColumns: Column<typeof purchaseOrders[number]>[] = [
    {
      key: "number", header: t("purchases.title"),
      render: (po) => (
        <Link href={`/${locale}/purchases/${po.id}`} className="font-medium text-brand hover:underline">
          {po.purchaseOrderNumber}
        </Link>
      ),
    },
    { key: "orderDate", header: t("purchases.orderDate"), render: (po) => formatBusinessDate(po.orderDate, locale) },
    ...(canViewCost ? [{
      key: "total", header: t("purchases.grandTotal"), align: "end" as const,
      render: (po: typeof purchaseOrders[number]) => <Money minor={po.grandTotal} locale={locale} currency={ctx.currency} />,
    }] : []),
    {
      key: "paymentStatus", header: t("purchases.paymentStatus"),
      // Same CANCELLED-aware rendering as the purchases list/detail pages —
      // cancelPurchaseOrder leaves paymentStatus untouched (docs/decisions.md #1).
      render: (po) => {
        const label = po.status === "CANCELLED" ? t("status.CANCELLED") : t(`status.${po.paymentStatus}`);
        const tone = po.status === "CANCELLED" ? "danger" : paymentTone(po.paymentStatus);
        return <StatusBadge label={label} tone={tone} />;
      },
    },
    {
      key: "status", header: t("app.status"),
      render: (po) => <StatusBadge label={t(`status.${po.status}`)} tone={statusTone(po.status)} />,
    },
  ];

  const paymentColumns: Column<typeof payments[number]>[] = [
    { key: "date", header: t("purchases.paymentDate"), render: (p) => formatBusinessDate(p.paymentDate, locale) },
    { key: "number", header: t("finance.recordPayment"), render: (p) => p.paymentNumber },
    { key: "account", header: t("finance.accounts"), render: (p) => p.account.name },
    { key: "amount", header: t("purchases.paidAmount"), align: "end", render: (p) => <Money minor={p.amount} locale={locale} currency={ctx.currency} /> },
    { key: "reference", header: t("purchases.referenceNumber"), render: (p) => p.referenceNumber ?? "—" },
  ];

  const statementRows = statement.map((s) => ({ ...s, id: s.id }));
  const statementColumns: Column<typeof statementRows[number]>[] = [
    { key: "date", header: t("suppliers.statementDate"), render: (s) => formatBusinessDate(s.transactionDate, locale) },
    {
      // Translated through suppliers.statementTypeOptions, not the raw
      // stored string — appendSupplierLedger (src/services/ledger.ts) only
      // ever writes "GOODS_RECEIVED" or "PAYMENT" (see receivePurchase/
      // recordSupplierPayment); statementTypeLabel falls back to the raw
      // value for anything else rather than rendering blank.
      key: "type", header: t("suppliers.statementType"),
      render: (s) => statementTypeLabel(s.transactionType),
    },
    { key: "reference", header: t("suppliers.statementReference"), render: (s) => s.referenceNumber },
    { key: "debit", header: t("suppliers.debit"), align: "end", render: (s) => (s.debitAmount > 0 ? <Money minor={s.debitAmount} locale={locale} currency={ctx.currency} /> : "—") },
    { key: "credit", header: t("suppliers.credit"), align: "end", render: (s) => (s.creditAmount > 0 ? <Money minor={s.creditAmount} locale={locale} currency={ctx.currency} /> : "—") },
    { key: "runningBalance", header: t("suppliers.runningBalance"), align: "end", render: (s) => <Money minor={s.runningBalance} locale={locale} currency={ctx.currency} tone="auto" /> },
  ];

  const editLabels: SupplierFormLabels = {
    name: t("suppliers.name"), companyName: t("suppliers.companyName"),
    contactPerson: t("suppliers.contactPerson"), phone: t("suppliers.phone"), email: t("suppliers.email"),
    country: t("suppliers.country"), city: t("suppliers.city"), address: t("suppliers.address"),
    taxNumber: t("suppliers.taxNumber"), paymentTermsDays: t("suppliers.paymentTermsDays"),
    notes: t("suppliers.notes"),
    save: t("app.save"), cancel: t("app.cancel"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.INVALID_NAME": t("errors.INVALID_NAME"),
      "errors.INVALID_PAYMENT_TERMS": t("errors.INVALID_PAYMENT_TERMS"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">{supplier.name}</h1>
          <p className="text-sm text-muted">
            {[supplier.city, supplier.country].filter(Boolean).join(", ") || "—"}
            {supplier.phone ? ` · ${supplier.phone}` : ""}
          </p>
          <div className="mt-1">
            <StatusBadge label={t(`status.${supplier.status}`)} tone={supplier.status === "ACTIVE" ? "success" : "neutral"} />
          </div>
        </div>
        {canEdit ? (
          <SupplierEditSection
            locale={locale}
            supplierId={supplier.id}
            defaults={{
              name: supplier.name, companyName: supplier.companyName ?? "",
              contactPerson: supplier.contactPerson ?? "", phone: supplier.phone ?? "",
              email: supplier.email ?? "", country: supplier.country ?? "", city: supplier.city ?? "",
              address: supplier.address ?? "", taxNumber: supplier.taxNumber ?? "",
              paymentTermsDays: String(supplier.paymentTermsDays), notes: supplier.notes ?? "",
            }}
            labels={editLabels}
            editLabel={t("app.edit")}
          />
        ) : null}
      </div>

      <PageSection title={t("suppliers.overview")}>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("suppliers.balance")}</div>
              <div className="mt-1 text-lg font-semibold">
                <Money minor={balance} locale={locale} currency={ctx.currency} tone="auto" />
              </div>
            </div>
          ) : null}
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("suppliers.totalPurchases")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={totalPurchases} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
          <div>
            <div className="text-xs text-muted">{t("suppliers.paymentTermsDays")}</div>
            <div className="mt-1 text-lg font-semibold">{formatNumber(supplier.paymentTermsDays, locale)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("purchases.title")}</div>
            <div className="mt-1 text-lg font-semibold">{formatNumber(purchaseOrders.length, locale)}</div>
          </div>
        </div>
      </PageSection>

      <PageSection title={t("suppliers.purchaseOrdersSection")}>
        <DataTable columns={poColumns} rows={purchaseOrders} empty={<EmptyState message={t("purchases.empty")} />} />
      </PageSection>

      {canViewCost ? (
        <PageSection title={t("suppliers.paymentsSection")}>
          <DataTable columns={paymentColumns} rows={payments} empty={<EmptyState message={t("purchases.noPayments")} />} />
        </PageSection>
      ) : null}

      {canViewCost ? (
        <PageSection title={t("suppliers.statement")}>
          <DataTable columns={statementColumns} rows={statementRows} empty={<EmptyState message={t("suppliers.statementEmpty")} />} />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={statementTotal}
            // Omits ?page= for `lastPage` (the default landing page here),
            // not for page 1 — the reverse of every other Pagination caller
            // on this screen, because the statement's own default page is
            // the last one, not the first (see the comment above `page`).
            buildHref={(target) => `/${locale}/suppliers/${supplier.id}${target !== lastPage ? `?page=${target}` : ""}`}
            labels={{
              previous: t("app.previous"), next: t("app.next"),
              pageInfo: t("app.pageOf", {
                page: formatNumber(page, locale),
                pages: formatNumber(lastPage, locale),
              }),
            }}
          />
        </PageSection>
      ) : null}
    </div>
  );
}

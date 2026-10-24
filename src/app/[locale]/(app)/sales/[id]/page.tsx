import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { LIVE_ORDER_STATUSES } from "@/services/reporting";
import { fromCost } from "@/lib/money";
import { formatQty, formatBusinessDate, formatBusinessDateTime, formatPct } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SaleDetailActions, type SaleDetailActionsLabels } from "./SaleDetailActions";

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

export default async function SaleDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "sales.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter —
  // same tenant-boundary rule as every other Task 5-9 detail page: an id
  // from another company, or one that no longer exists, must read as a
  // routine 404, not a tenant-boundary leak or a 500.
  const order = await prisma.salesOrder.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      customer: true,
      warehouse: { select: { name: true } },
      items: { include: { product: { select: { nameAr: true, nameEn: true, sku: true } } }, orderBy: { id: "asc" } },
      costs: true,
      payments: { include: { account: { select: { name: true } } }, orderBy: { paymentDate: "desc" } },
      returns: { include: { items: true }, orderBy: { returnDate: "desc" } },
    },
  });
  if (!order) notFound();

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canViewProfit = can(ctx.role, "finance.view_profit");
  // Cancel is CONFIRMED-only: no service discards a DRAFT (drafts accumulate
  // harmlessly, Task 8 brief) and cancelSale itself throws
  // SALES_ORDER_NOT_CONFIRMED on anything else, including an
  // already-cancelled order.
  const canCancel = can(ctx.role, "sales.cancel") && order.status === "CONFIRMED";
  const hasReturnableLine = order.items.some((i) => i.quantity - i.returnedQty > 0);
  const canReturn = can(ctx.role, "sales.return") && order.status === "CONFIRMED" && hasReturnableLine;
  // Walk-in orders (no customerId) cannot take a linked customer payment —
  // recordCustomerPayment requires a customerId (Task 8 brief, "by design").
  // Restricted to CONFIRMED (not merely "!= CANCELLED"): recordCustomerPayment
  // has no DRAFT guard of its own, but a DRAFT sale has no receivable yet
  // (confirmSale is what posts it), so offering payment against one here
  // would be a dead end no other part of this screen supports either.
  const canPay = can(ctx.role, "payments.create") && order.status === "CONFIRMED" && !!order.customerId;

  const accounts = canPay
    ? await prisma.financialAccount.findMany({
        where: { companyId: ctx.companyId, status: "ACTIVE" },
        orderBy: { name: "asc" },
      })
    : [];

  const returnIds = order.returns.map((r) => r.id);
  const auditRows = await prisma.auditLog.findMany({
    where: {
      companyId: ctx.companyId,
      OR: [
        { entityType: "SalesOrder", entityId: order.id },
        ...(returnIds.length ? [{ entityType: "CustomerReturn", entityId: { in: returnIds } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  const actorIds = [...new Set(auditRows.map((a) => a.userId).filter((x): x is string => !!x))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
    : [];
  const actorMap = new Map(actors.map((u) => [u.id, u.fullName]));

  // t() returns the bare key on a miss (src/lib/i18n.ts), so an unrecognized
  // action still shows something on screen rather than a raw
  // "sales.historyActions.X" string — same fallback pattern as suppliers'
  // statementTypeLabel.
  function historyActionLabel(action: string): string {
    const label = t(`sales.historyActions.${action}`);
    return label.startsWith("sales.historyActions.") ? action : label;
  }

  // Rows with status === CANCELLED render the CANCELLED status label here,
  // never the stored paymentStatus — cancelSale leaves that column untouched
  // (docs/decisions.md #1), same rule as the list page.
  const paymentStatusLabel = order.status === "CANCELLED" ? t("status.CANCELLED") : t(`status.${order.paymentStatus}`);
  const paymentStatusTone = order.status === "CANCELLED" ? "danger" : paymentTone(order.paymentStatus);

  const remainingBalance = Math.max(0, order.grandTotal - order.paidAmount);
  // Matches salesSummary's exact per-order revenue formula (src/services/
  // reporting.ts) — but salesSummary only ever applies that formula to LIVE
  // orders (status filter baked into the query). cancelSale adds
  // grandTotal-basis cash into the same `refundedAmount` field that
  // processReturn uses on a subtotal-basis, so a cancelled order's
  // `subtotal + shippingCharged - refundedAmount` is not a meaningful
  // revenue figure — it can even go negative (Stage 1B review, IMPORTANT 3).
  // Guarded the same way products/[id]/page.tsx nets its own per-line
  // profit figures to zero for a non-live order.
  const isLiveOrder = LIVE_ORDER_STATUSES.includes(order.status);
  const revenueNet = isLiveOrder
    ? order.subtotal + order.shippingCharged - order.refundedAmount
    : 0;
  const marginPct = revenueNet > 0 ? Math.round((order.netProfit / revenueNet) * 10_000) : null;
  const orderCostsTotal = order.costs.reduce((s, c) => s + c.amount, 0);

  // SalesOrderItem.lineTotal/totalCost/grossProfit/netProfit are immutable
  // posting-time snapshots (docs/decisions.md #8) — processReturn records
  // deltas in returnedQty/returnedRevenue/returnedCost without rewriting
  // them. Derive the per-line "kept" profit the same way bestSellers() does
  // (src/services/reporting.ts) rather than rendering the stale snapshot
  // fields raw, so this table never contradicts the dashboard for the same
  // order after a partial return. The cost SNAPSHOT columns below are
  // deliberately the raw immutable figures (that's what "snapshot" means);
  // only the profit column is netted.
  const itemRows = order.items.map((item) => {
    const netRevenue = item.lineTotal - item.returnedRevenue;
    const netCost = item.totalCost - item.returnedCost;
    const allocated = item.allocatedShipping + item.allocatedPlatformFee
      + item.allocatedPaymentFee + item.allocatedCommission + item.allocatedOtherCost;
    return {
      ...item, id: item.id,
      netProfitDerived: netRevenue - netCost - allocated,
    };
  });

  const itemColumns: Column<typeof itemRows[number]>[] = [
    { key: "product", header: t("dashboard.product"), render: (r) => (locale === "ar" ? r.product.nameAr : r.product.nameEn) },
    { key: "sku", header: t("products.sku"), render: (r) => r.product.sku },
    { key: "quantity", header: t("inventory.quantity"), align: "end", render: (r) => formatQty(r.quantity, locale) },
    { key: "returned", header: t("sales.returnedQty"), align: "end", render: (r) => formatQty(r.returnedQty, locale) },
    { key: "unitPrice", header: t("purchases.unitPrice"), align: "end", render: (r) => <Money minor={r.unitPrice} locale={locale} currency={ctx.currency} /> },
    { key: "discount", header: t("purchases.discount"), align: "end", render: (r) => <Money minor={r.discountAmount} locale={locale} currency={ctx.currency} /> },
    { key: "tax", header: t("purchases.tax"), align: "end", render: (r) => <Money minor={r.taxAmount} locale={locale} currency={ctx.currency} /> },
    { key: "lineTotal", header: t("purchases.lineTotal"), align: "end", render: (r) => <Money minor={r.lineTotal} locale={locale} currency={ctx.currency} /> },
    ...(canViewCost ? [{
      key: "unitCost", header: t("inventory.unitCost"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={Math.round(fromCost(r.unitCostSnapshot))} locale={locale} currency={ctx.currency} />,
    }, {
      key: "totalCost", header: t("inventory.totalCost"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.totalCost} locale={locale} currency={ctx.currency} />,
    }] : []),
    ...(canViewProfit ? [{
      key: "profit", header: t("sales.profit"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.netProfitDerived} locale={locale} currency={ctx.currency} tone="auto" />,
    }] : []),
  ];

  const paymentRows = order.payments.map((p) => ({ ...p, id: p.id }));
  const paymentColumns: Column<typeof paymentRows[number]>[] = [
    { key: "date", header: t("purchases.paymentDate"), render: (p) => formatBusinessDate(p.paymentDate, locale) },
    { key: "number", header: t("finance.paymentNumber"), render: (p) => p.paymentNumber },
    { key: "type", header: t("suppliers.statementType"), render: (p) => t(`customers.statementTypeOptions.${p.paymentType === "REFUND" ? "REFUND" : "PAYMENT"}`) },
    { key: "account", header: t("finance.accounts"), render: (p) => p.account.name },
    { key: "amount", header: t("purchases.paidAmount"), align: "end", render: (p) => <Money minor={p.amount} locale={locale} currency={ctx.currency} /> },
    { key: "reference", header: t("purchases.referenceNumber"), render: (p) => p.referenceNumber ?? "—" },
  ];

  const returnRows = order.returns.map((r) => ({ ...r, id: r.id, unitsReturned: r.items.reduce((s, i) => s + i.quantity, 0) }));
  const returnColumns: Column<typeof returnRows[number]>[] = [
    { key: "number", header: t("sales.returnNumber"), render: (r) => r.returnNumber },
    { key: "date", header: t("app.date"), render: (r) => formatBusinessDate(r.returnDate, locale) },
    { key: "units", header: t("sales.returnedQty"), align: "end", render: (r) => formatQty(r.unitsReturned, locale) },
    { key: "refund", header: t("sales.refundAmount"), align: "end", render: (r) => <Money minor={r.refundAmount} locale={locale} currency={ctx.currency} /> },
    { key: "reason", header: t("inventory.reason"), render: (r) => r.reason ?? "—" },
  ];

  const historyRows = auditRows.map((a) => ({ ...a, id: a.id, actorName: a.userId ? (actorMap.get(a.userId) ?? "—") : "—" }));
  const historyColumns: Column<typeof historyRows[number]>[] = [
    { key: "date", header: t("app.date"), render: (a) => formatBusinessDateTime(a.createdAt, locale) },
    { key: "action", header: t("app.actions"), render: (a) => historyActionLabel(a.action) },
    { key: "by", header: t("inventory.recordedBy"), render: (a) => a.actorName },
  ];

  const cancelWarningUnits = formatQty(
    order.items.reduce((s, i) => s + (i.quantity - i.returnedQty), 0), locale,
  );

  const actionsLabels: SaleDetailActionsLabels = {
    cancelOrder: t("sales.cancel"), cancelReason: t("purchases.cancelReason"),
    cancelOrderTitle: t("sales.cancel"), cancelWarningTemplate: t("sales.cancelWarning"),
    recordPayment: t("finance.recordPayment"), remainingBalance: t("sales.remainingBalance"),
    paymentAmount: t("purchases.paymentAmount"), paymentDate: t("purchases.paymentDate"),
    referenceNumber: t("purchases.referenceNumber"), notes: t("inventory.notes"), account: t("sales.account"),
    confirmPaymentTitle: t("purchases.confirmPaymentTitle"),
    confirmPaymentMessageTemplate: t("sales.confirmPaymentMessageTemplate"),
    printInvoice: t("sales.printInvoice"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.SALES_ORDER_NOT_CONFIRMED": t("errors.SALES_ORDER_NOT_CONFIRMED"),
      "errors.ALREADY_CANCELLED": t("errors.ALREADY_CANCELLED"),
      "errors.REASON_REQUIRED": t("errors.REASON_REQUIRED"),
      "errors.PAYMENT_EXCEEDS_TOTAL": t("errors.PAYMENT_EXCEEDS_TOTAL"),
      "errors.ORDER_CANCELLED": t("errors.ORDER_CANCELLED"),
      "errors.ORDER_NOT_CONFIRMED": t("errors.ORDER_NOT_CONFIRMED"),
      "errors.AMOUNT_MUST_BE_POSITIVE": t("errors.AMOUNT_MUST_BE_POSITIVE"),
      "errors.ACCOUNT_REQUIRED": t("errors.ACCOUNT_REQUIRED"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">{order.salesOrderNumber}</h1>
          <p className="text-sm text-muted">
            {order.customer?.name ?? t("sales.walkIn")} · {order.warehouse.name} · {t(`sales.channelOptions.${order.channel}`)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge label={t(`status.${order.status}`)} tone={statusTone(order.status)} />
            <StatusBadge label={paymentStatusLabel} tone={paymentStatusTone} />
          </div>
        </div>
        {canReturn ? (
          <Link
            href={`/${locale}/sales/${order.id}/return`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink print:hidden"
          >
            {t("sales.return")}
          </Link>
        ) : null}
      </div>

      <PageSection title={t("purchases.overview")}>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">{t("purchases.orderDate")}</div>
            <div className="mt-1 text-lg font-semibold">{formatBusinessDate(order.orderDate, locale)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("purchases.grandTotal")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={order.grandTotal} locale={locale} currency={ctx.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("purchases.paidAmount")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={order.paidAmount} locale={locale} currency={ctx.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("sales.remainingBalance")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={remainingBalance} locale={locale} currency={ctx.currency} tone="auto" /></div>
          </div>
          {order.refundedAmount > 0 ? (
            <div>
              <div className="text-xs text-muted">{t("sales.refundAmount")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={order.refundedAmount} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
        </div>
        {order.notes ? <p className="mt-3 text-sm text-muted">{order.notes}</p> : null}
      </PageSection>

      {/* Rendered unconditionally, not gated on (canCancel || canPay) — the
          print button lives inside SaleDetailActions, and printing is a read
          action available to anyone who can view this page at all (e.g. a
          VIEWER, who holds neither sales.cancel nor payments.create). Only
          used to leave a VIEWER with no way to print an invoice they can
          already see on screen (Stage 1B review, IMPORTANT 9). canCancel/
          canPay independently gate the cancel button and payment form inside
          the component itself. */}
      <PageSection>
        <SaleDetailActions
          locale={locale}
          currency={ctx.currency}
          salesOrderId={order.id}
          customerId={order.customerId}
          customerName={order.customer?.name ?? t("sales.walkIn")}
          cancelWarningUnits={cancelWarningUnits}
          cancelWarningWarehouse={order.warehouse.name}
          remainingBalance={remainingBalance}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          canCancel={canCancel}
          canPay={canPay}
          labels={actionsLabels}
        />
      </PageSection>

      <PageSection title={t("purchases.itemsSection")}>
        <DataTable columns={itemColumns} rows={itemRows} empty={<EmptyState message={t("sales.noItems")} />} />
      </PageSection>

      <PageSection title={t("purchases.paymentsSection")}>
        <DataTable columns={paymentColumns} rows={paymentRows} empty={<EmptyState message={t("purchases.noPayments")} />} />
      </PageSection>

      <PageSection title={t("sales.returnsSection")}>
        <DataTable columns={returnColumns} rows={returnRows} empty={<EmptyState message={t("sales.noReturns")} />} />
      </PageSection>

      {canViewProfit ? (
        <PageSection title={t("sales.profitabilitySection")}>
          {/*
            All-or-nothing for a non-live order. Zeroing revenue alone (the
            correct call — see revenueNet above) left a panel reading 0
            revenue beside real order-costs and shipping figures, which
            invites the reader to treat the difference as a loss. There is no
            partial truth to tell here: a cancelled or draft order has no
            revenue to measure profitability against, so say that instead.
          */}
          {!isLiveOrder ? (
            <EmptyState message={t("sales.profitabilityNotApplicable")} />
          ) : (
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted">{t("dashboard.revenue")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={revenueNet} locale={locale} currency={ctx.currency} /></div>
            </div>
            {canViewCost ? (
              <div>
                <div className="text-xs text-muted">{t("sales.productCost")}</div>
                <div className="mt-1 text-lg font-semibold"><Money minor={order.totalCost} locale={locale} currency={ctx.currency} /></div>
              </div>
            ) : null}
            <div>
              <div className="text-xs text-muted">{t("dashboard.grossProfit")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={order.grossProfit} locale={locale} currency={ctx.currency} tone="auto" /></div>
            </div>
            <div>
              <div className="text-xs text-muted">{t("sales.orderCosts")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={orderCostsTotal} locale={locale} currency={ctx.currency} /></div>
            </div>
            <div>
              <div className="text-xs text-muted">{t("sales.shippingCharged")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={order.shippingCharged} locale={locale} currency={ctx.currency} /></div>
            </div>
            <div>
              <div className="text-xs text-muted">{t("dashboard.netProfit")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={order.netProfit} locale={locale} currency={ctx.currency} tone="auto" /></div>
            </div>
            <div>
              <div className="text-xs text-muted">{t("products.margin")}</div>
              <div className="mt-1 text-lg font-semibold">{marginPct !== null ? formatPct(marginPct, locale) : "—"}</div>
            </div>
          </div>
          )}
        </PageSection>
      ) : null}

      <PageSection title={t("sales.historySection")}>
        <div className="print:hidden">
          <DataTable columns={historyColumns} rows={historyRows} empty={<EmptyState message={t("sales.noHistory")} />} />
        </div>
      </PageSection>
    </div>
  );
}

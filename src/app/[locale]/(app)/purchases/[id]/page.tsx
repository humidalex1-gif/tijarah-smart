import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fromCost } from "@/lib/money";
import { formatQty, formatBusinessDate } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSection } from "@/components/ui/PageSection";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PurchaseDetailActions, type PurchaseDetailActionsLabels } from "./PurchaseDetailActions";

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
function receivingTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "RECEIVED") return "success";
  if (status === "PARTIAL") return "warning";
  return "neutral";
}

export default async function PurchaseDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "purchases.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter —
  // same tenant-boundary rule as every other Task 5-9 detail page: an id
  // from another company, or one that no longer exists, must read as a
  // routine 404, not a tenant-boundary leak or a 500.
  const po = await prisma.purchaseOrder.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      supplier: true,
      warehouse: { select: { name: true } },
      items: { include: { product: { select: { nameAr: true, nameEn: true, sku: true } } } },
      additionalCosts: true,
      receipts: {
        include: { items: true },
        orderBy: { receivedDate: "desc" },
      },
      payments: { include: { account: { select: { name: true } } }, orderBy: { paymentDate: "desc" } },
    },
  });
  if (!po) notFound();

  const canViewCost = can(ctx.role, "finance.view_cost");
  const canConfirm = can(ctx.role, "purchases.confirm") && po.status === "DRAFT";
  const canReceive = can(ctx.role, "purchases.receive")
    && po.status === "CONFIRMED" && po.receivingStatus !== "RECEIVED";
  // Cancel is only offered when nothing has been received yet —
  // cancelPurchaseOrder itself throws PURCHASE_ALREADY_RECEIVED otherwise, so
  // hiding the button here matches what the service would allow anyway.
  const canCancel = can(ctx.role, "purchases.cancel")
    && po.status !== "CANCELLED" && po.items.every((i) => i.receivedQty === 0);
  // recordSupplierPayment rejects a CANCELLED order (ORDER_CANCELLED).
  const canPay = can(ctx.role, "payments.create") && po.status !== "CANCELLED";

  const accounts = canPay
    ? await prisma.financialAccount.findMany({
        where: { companyId: ctx.companyId, status: "ACTIVE" },
        orderBy: { name: "asc" },
      })
    : [];

  // Additional costs (freight, customs, handling) are deliberately not a
  // supplier payable (docs/decisions.md / Task 8 design) — the payable is
  // goods + tax only, and the payment-status badge is derived against THIS
  // figure, never grandTotal, matching recordSupplierPayment's own
  // PAYMENT_EXCEEDS_TOTAL cap and statusFor() call.
  const payable = po.grandTotal - po.additionalCostTotal;
  const payableRemaining = Math.max(0, payable - po.paidAmount);

  // Rows with status === CANCELLED render the CANCELLED status label here,
  // never the stored paymentStatus — cancelPurchaseOrder leaves that column
  // untouched (docs/decisions.md #1), same rule as the list page.
  const paymentStatusLabel = po.status === "CANCELLED" ? t("status.CANCELLED") : t(`status.${po.paymentStatus}`);
  const paymentStatusTone = po.status === "CANCELLED" ? "danger" : paymentTone(po.paymentStatus);

  const itemRows = po.items.map((item) => ({ ...item, id: item.id }));
  const itemColumns: Column<typeof itemRows[number]>[] = [
    {
      key: "product", header: t("dashboard.product"),
      render: (r) => (locale === "ar" ? r.product.nameAr : r.product.nameEn),
    },
    { key: "sku", header: t("products.sku"), render: (r) => r.product.sku },
    { key: "ordered", header: t("purchases.orderedQty"), align: "end", render: (r) => formatQty(r.orderedQty, locale) },
    { key: "received", header: t("purchases.receivedQty"), align: "end", render: (r) => formatQty(r.receivedQty, locale) },
    ...(canViewCost ? [{
      key: "unitPrice", header: t("purchases.unitPrice"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.unitPrice} locale={locale} currency={ctx.currency} />,
    }, {
      key: "discount", header: t("purchases.discount"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.discountAmount} locale={locale} currency={ctx.currency} />,
    }, {
      key: "tax", header: t("purchases.tax"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.taxAmount} locale={locale} currency={ctx.currency} />,
    }, {
      key: "lineTotal", header: t("purchases.lineTotal"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.lineTotal} locale={locale} currency={ctx.currency} />,
    }, {
      key: "allocated", header: t("purchases.additionalCosts"), align: "end" as const,
      render: (r: typeof itemRows[number]) => <Money minor={r.allocatedAdditionalCost} locale={locale} currency={ctx.currency} />,
    }, {
      key: "landed", header: t("purchases.landedCost"), align: "end" as const,
      // landedUnitCost (like InventoryBalance.avgCost) is a COST_SCALE-scaled
      // unit cost, not a plain minor-unit amount — fromCost converts it
      // before it reaches <Money>, same as every avgCost column elsewhere.
      render: (r: typeof itemRows[number]) => (
        <Money minor={Math.round(fromCost(r.landedUnitCost))} locale={locale} currency={ctx.currency} />
      ),
    }] : []),
  ];

  const receiptRows = po.receipts.map((r) => ({
    ...r,
    id: r.id,
    accepted: r.items.reduce((s, i) => s + i.acceptedQty, 0),
    damaged: r.items.reduce((s, i) => s + i.damagedQty, 0),
  }));
  const receiptColumns: Column<typeof receiptRows[number]>[] = [
    { key: "number", header: t("purchases.receiptNumber"), render: (r) => r.receiptNumber },
    { key: "date", header: t("purchases.receivedDate"), render: (r) => formatBusinessDate(r.receivedDate, locale) },
    { key: "accepted", header: t("purchases.acceptedQty"), align: "end", render: (r) => formatQty(r.accepted, locale) },
    { key: "damaged", header: t("purchases.damagedQty"), align: "end", render: (r) => formatQty(r.damaged, locale) },
    { key: "notes", header: t("inventory.notes"), render: (r) => r.notes ?? "—" },
  ];

  const paymentRows = po.payments.map((p) => ({ ...p, id: p.id }));
  const paymentColumns: Column<typeof paymentRows[number]>[] = [
    { key: "date", header: t("purchases.paymentDate"), render: (p) => formatBusinessDate(p.paymentDate, locale) },
    { key: "number", header: t("finance.recordPayment"), render: (p) => p.paymentNumber },
    { key: "account", header: t("finance.accounts"), render: (p) => p.account.name },
    { key: "amount", header: t("purchases.paidAmount"), align: "end", render: (p) => <Money minor={p.amount} locale={locale} currency={ctx.currency} /> },
    { key: "reference", header: t("purchases.referenceNumber"), render: (p) => p.referenceNumber ?? "—" },
  ];

  const costRows = po.additionalCosts.map((c) => ({ ...c, id: c.id }));
  const costColumns: Column<typeof costRows[number]>[] = [
    { key: "type", header: t("purchases.costType"), render: (c) => t(`purchases.costTypeOptions.${c.costType}`) },
    { key: "description", header: t("purchases.costDescription"), render: (c) => c.description ?? "—" },
    { key: "amount", header: t("purchases.costAmount"), align: "end", render: (c) => <Money minor={c.amount} locale={locale} currency={ctx.currency} /> },
  ];

  const actionsLabels: PurchaseDetailActionsLabels = {
    confirmOrder: t("purchases.confirmOrder"), confirmOrderTitle: t("purchases.confirmOrderTitle"),
    confirmOrderMessage: t("purchases.confirmOrderMessage"),
    cancelOrder: t("purchases.cancelOrder"), cancelReason: t("purchases.cancelReason"),
    cancelOrderTitle: t("purchases.cancelOrderTitle"), cancelOrderMessageTemplate: t("purchases.cancelOrderMessageTemplate"),
    recordPayment: t("purchases.recordPayment"), payable: t("purchases.payable"),
    paymentAmount: t("purchases.paymentAmount"), paymentDate: t("purchases.paymentDate"),
    referenceNumber: t("purchases.referenceNumber"), notes: t("inventory.notes"),
    account: t("finance.accounts"),
    confirmPaymentTitle: t("purchases.confirmPaymentTitle"),
    confirmPaymentMessageTemplate: t("purchases.confirmPaymentMessageTemplate"),
    remainingPayable: t("purchases.remainingPayable"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.PURCHASE_ORDER_NOT_DRAFT": t("errors.PURCHASE_ORDER_NOT_DRAFT"),
      "errors.ALREADY_CANCELLED": t("errors.ALREADY_CANCELLED"),
      "errors.PURCHASE_ALREADY_RECEIVED": t("errors.PURCHASE_ALREADY_RECEIVED"),
      "errors.REASON_REQUIRED": t("errors.REASON_REQUIRED"),
      "errors.PAYMENT_EXCEEDS_TOTAL": t("errors.PAYMENT_EXCEEDS_TOTAL"),
      "errors.ORDER_CANCELLED": t("errors.ORDER_CANCELLED"),
      "errors.AMOUNT_MUST_BE_POSITIVE": t("errors.AMOUNT_MUST_BE_POSITIVE"),
      "errors.ACCOUNT_REQUIRED": t("errors.ACCOUNT_REQUIRED"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">{po.purchaseOrderNumber}</h1>
          <p className="text-sm text-muted">{po.supplier.name} · {po.warehouse.name}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge label={t(`status.${po.status}`)} tone={statusTone(po.status)} />
            <StatusBadge label={paymentStatusLabel} tone={paymentStatusTone} />
            {/* purchases.receivingStatusOptions, not status.* — receivingStatus's
                own PARTIAL value would otherwise collide with paymentStatus's
                identically-named PARTIAL member (docs comment in page.tsx list
                view has the full rationale). */}
            <StatusBadge label={t(`purchases.receivingStatusOptions.${po.receivingStatus}`)} tone={receivingTone(po.receivingStatus)} />
          </div>
        </div>
        {canReceive ? (
          <Link
            href={`/${locale}/purchases/${po.id}/receive`}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink"
          >
            {t("purchases.receive")}
          </Link>
        ) : null}
      </div>

      <PageSection title={t("purchases.overview")}>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">{t("purchases.orderDate")}</div>
            <div className="mt-1 text-lg font-semibold">{formatBusinessDate(po.orderDate, locale)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("purchases.expectedDate")}</div>
            <div className="mt-1 text-lg font-semibold">
              {po.expectedDate ? formatBusinessDate(po.expectedDate, locale) : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("purchases.allocationMethod")}</div>
            <div className="mt-1 text-lg font-semibold">{t(`purchases.allocationOptions.${po.allocationMethod}`)}</div>
          </div>
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("purchases.grandTotal")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={po.grandTotal} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("purchases.payable")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={payable} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
          {canViewCost ? (
            <div>
              <div className="text-xs text-muted">{t("purchases.paidAmount")}</div>
              <div className="mt-1 text-lg font-semibold"><Money minor={po.paidAmount} locale={locale} currency={ctx.currency} /></div>
            </div>
          ) : null}
        </div>
        {po.notes ? <p className="mt-3 text-sm text-muted">{po.notes}</p> : null}
      </PageSection>

      {(canConfirm || canCancel || canPay) ? (
        <PageSection>
          <PurchaseDetailActions
            locale={locale}
            currency={ctx.currency}
            purchaseOrderId={po.id}
            purchaseOrderNumber={po.purchaseOrderNumber}
            supplierId={po.supplierId}
            supplierName={po.supplier.name}
            payableRemaining={payableRemaining}
            accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
            canConfirm={canConfirm}
            canCancel={canCancel}
            canPay={canPay}
            labels={actionsLabels}
          />
        </PageSection>
      ) : null}

      <PageSection title={t("purchases.itemsSection")}>
        <DataTable columns={itemColumns} rows={itemRows} empty={<EmptyState message={t("purchases.noItems")} />} />
      </PageSection>

      {canViewCost && costRows.length > 0 ? (
        <PageSection title={t("purchases.landedCostBreakdown")}>
          <DataTable columns={costColumns} rows={costRows} empty={<EmptyState message={t("purchases.noCosts")} />} />
        </PageSection>
      ) : null}

      <PageSection title={t("purchases.receiptsSection")}>
        <DataTable columns={receiptColumns} rows={receiptRows} empty={<EmptyState message={t("purchases.noReceipts")} />} />
      </PageSection>

      {canViewCost ? (
        <PageSection title={t("purchases.paymentsSection")}>
          <DataTable columns={paymentColumns} rows={paymentRows} empty={<EmptyState message={t("purchases.noPayments")} />} />
        </PageSection>
      ) : null}
    </div>
  );
}

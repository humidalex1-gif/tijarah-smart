import { notFound, redirect } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { RETURN_CONDITIONS } from "@/lib/constants";
import { ReturnForm, type ReturnFormLabels } from "./ReturnForm";

export default async function SaleReturnPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "sales.return", locale);
  const t = await getTranslator(locale);

  const order = await prisma.salesOrder.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      warehouse: { select: { name: true } },
      items: { include: { product: { select: { nameAr: true, nameEn: true } } } },
    },
  });
  if (!order) notFound();

  const returnableItems = order.items.filter((item) => item.quantity - item.returnedQty > 0);

  // processReturn itself throws SALES_ORDER_NOT_CONFIRMED for anything but a
  // CONFIRMED order — this is a routine navigation guard (the "Create
  // return" link on the detail page is already hidden for a DRAFT/CANCELLED/
  // fully-returned order), not an error state, so it sends the merchant back
  // to the detail page rather than rendering a dead form. Same pattern as
  // purchases/[id]/receive/page.tsx.
  if (order.status !== "CONFIRMED" || returnableItems.length === 0) {
    redirect(`/${locale}/sales/${order.id}`);
  }

  const [accounts, warehouses] = await Promise.all([
    prisma.financialAccount.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    // Every active warehouse, not just the order's own — processReturn
    // accepts a per-line `warehouseId` that can differ from the order's
    // (e.g. routing a damaged unit to a dedicated damaged-goods warehouse),
    // defaulting to the order's warehouse only when a line omits it.
    prisma.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);

  const items = returnableItems.map((item) => ({
    itemId: item.id,
    productName: locale === "ar" ? item.product.nameAr : item.product.nameEn,
    soldQty: item.quantity,
    returnedQty: item.returnedQty,
  }));

  const conditionOptions = Object.fromEntries(
    RETURN_CONDITIONS.map((c) => [c, t(`sales.conditionOptions.${c}`)]),
  ) as ReturnFormLabels["conditionOptions"];

  const labels: ReturnFormLabels = {
    product: t("dashboard.product"), soldQty: t("inventory.quantity"),
    alreadyReturned: t("sales.alreadyReturned"), remaining: t("purchases.remaining"),
    returnQty: t("sales.returnQty"), condition: t("sales.returnCondition"), conditionOptions,
    targetWarehouse: t("purchases.warehouse"), refundAmount: t("sales.refundAmount"),
    refundAccount: t("sales.refundAccount"), returnReason: t("sales.returnReason"),
    maxRefundHintTemplate: t("sales.maxRefundHint"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("sales.createReturnConfirmTitle"),
    confirmMessageTemplate: t("sales.createReturnConfirmMessageTemplate"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.NO_LINES": t("errors.NO_LINES"),
      "errors.TOO_MANY_LINES": t("errors.TOO_MANY_LINES"),
      "errors.INVALID_LINES": t("errors.INVALID_LINES"),
      "errors.QUANTITY_MUST_BE_POSITIVE": t("errors.QUANTITY_MUST_BE_POSITIVE"),
      "errors.DUPLICATE_RETURN_LINE": t("errors.DUPLICATE_RETURN_LINE"),
      "errors.RETURN_EXCEEDS_SOLD": t("errors.RETURN_EXCEEDS_SOLD"),
      "errors.INVALID_REFUND_AMOUNT": t("errors.INVALID_REFUND_AMOUNT"),
      "errors.REFUND_DESTINATION_REQUIRED": t("errors.REFUND_DESTINATION_REQUIRED"),
      "errors.REFUND_EXCEEDS_ORDER": t("errors.REFUND_EXCEEDS_ORDER"),
      "errors.SALES_ITEM_NOT_FOUND": t("errors.SALES_ITEM_NOT_FOUND"),
      "errors.SALES_ORDER_NOT_CONFIRMED": t("errors.SALES_ORDER_NOT_CONFIRMED"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">
        {t("sales.return")}: {order.salesOrderNumber}
      </h1>
      <ReturnForm
        locale={locale}
        currency={ctx.currency}
        salesOrderId={order.id}
        hasCustomer={!!order.customerId}
        defaultWarehouseId={order.warehouseId}
        defaultWarehouseName={order.warehouse.name}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        maxRefund={Math.max(0, order.grandTotal - order.refundedAmount)}
        items={items}
        labels={labels}
      />
    </div>
  );
}

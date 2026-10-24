import { notFound, redirect } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { ReceivePurchaseForm, type ReceivePurchaseFormLabels } from "./ReceivePurchaseForm";

export default async function ReceivePurchasePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "purchases.receive", locale);
  const t = await getTranslator(locale);

  const po = await prisma.purchaseOrder.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      warehouse: { select: { name: true } },
      items: { include: { product: { select: { nameAr: true, nameEn: true } } } },
    },
  });
  if (!po) notFound();

  // receivePurchase itself throws PURCHASE_ORDER_NOT_CONFIRMED for anything
  // but a CONFIRMED order — this is a routine navigation guard (the "Receive
  // stock" link on the detail page is already hidden for a DRAFT/CANCELLED/
  // fully-RECEIVED order), not an error state, so it sends the merchant back
  // to the detail page rather than rendering a dead form.
  if (po.status !== "CONFIRMED" || po.receivingStatus === "RECEIVED") {
    redirect(`/${locale}/purchases/${po.id}`);
  }

  const items = po.items
    .filter((item) => item.orderedQty - item.receivedQty > 0)
    .map((item) => ({
      itemId: item.id,
      productName: locale === "ar" ? item.product.nameAr : item.product.nameEn,
      orderedQty: item.orderedQty,
      receivedQty: item.receivedQty,
    }));

  const labels: ReceivePurchaseFormLabels = {
    product: t("dashboard.product"), orderedQty: t("purchases.orderedQty"),
    alreadyReceived: t("purchases.alreadyReceived"), remaining: t("purchases.remaining"),
    acceptedQty: t("purchases.acceptedQty"), damagedQty: t("purchases.damagedQty"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("purchases.receiveTitle"), confirmMessageTemplate: t("purchases.receiveMessageTemplate"),
    landedCostHint: t("purchases.landedCostHint"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.NO_LINES": t("errors.NO_LINES"),
      "errors.TOO_MANY_LINES": t("errors.TOO_MANY_LINES"),
      "errors.INVALID_LINES": t("errors.INVALID_LINES"),
      "errors.EMPTY_RECEIPT_LINE": t("errors.EMPTY_RECEIPT_LINE"),
      "errors.DUPLICATE_RECEIPT_LINE": t("errors.DUPLICATE_RECEIPT_LINE"),
      "errors.RECEIVED_EXCEEDS_ORDERED": t("errors.RECEIVED_EXCEEDS_ORDERED"),
      "errors.QUANTITY_MUST_BE_NON_NEGATIVE": t("errors.QUANTITY_MUST_BE_NON_NEGATIVE"),
      "errors.PURCHASE_ITEM_NOT_FOUND": t("errors.PURCHASE_ITEM_NOT_FOUND"),
      "errors.PURCHASE_ORDER_NOT_CONFIRMED": t("errors.PURCHASE_ORDER_NOT_CONFIRMED"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">
        {t("purchases.receive")}: {po.purchaseOrderNumber}
      </h1>
      <ReceivePurchaseForm
        locale={locale}
        purchaseOrderId={po.id}
        purchaseOrderNumber={po.purchaseOrderNumber}
        warehouseName={po.warehouse.name}
        items={items}
        labels={labels}
      />
    </div>
  );
}

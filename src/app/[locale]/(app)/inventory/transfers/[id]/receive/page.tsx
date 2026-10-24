import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReceiveTransferForm, type ReceiveTransferFormLabels } from "./ReceiveTransferForm";

export default async function ReceiveTransferPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.transfer", locale);
  const t = await getTranslator(locale);

  // findFirst with an explicit companyId filter, never findUniqueOrThrow —
  // same tenant-boundary rule as every other detail page: a transfer id
  // from another company, or one that no longer exists, reads as a routine
  // 404, not a 500 or a cross-tenant leak.
  const transfer = await prisma.warehouseTransfer.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      destination: { select: { name: true } },
      items: { include: { product: { select: { nameAr: true, nameEn: true } } } },
    },
  });
  if (!transfer) notFound();

  const labels: ReceiveTransferFormLabels = {
    product: t("dashboard.product"), shippedQty: t("inventory.shippedQty"),
    receivedQty: t("inventory.receivedQty"), damagedQty: t("inventory.damaged"),
    remaining: t("inventory.difference"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmTitle: t("inventory.receiveTransferConfirmTitle"),
    confirmMessageTemplate: t("inventory.receiveTransferConfirmMessage"),
    receiveAllHint: t("inventory.receiveAllHint"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.TRANSFER_NOT_IN_TRANSIT": t("errors.TRANSFER_NOT_IN_TRANSIT"),
      "errors.TRANSFER_NOT_FULLY_RECEIVED": t("errors.TRANSFER_NOT_FULLY_RECEIVED"),
      "errors.TRANSFER_ITEM_NOT_FOUND": t("errors.TRANSFER_ITEM_NOT_FOUND"),
      "errors.DUPLICATE_TRANSFER_LINE": t("errors.DUPLICATE_TRANSFER_LINE"),
      "errors.RECEIVED_EXCEEDS_SHIPPED": t("errors.RECEIVED_EXCEEDS_SHIPPED"),
      "errors.QUANTITY_MUST_BE_NON_NEGATIVE": t("errors.QUANTITY_MUST_BE_NON_NEGATIVE"),
      "errors.INVALID_LINES": t("errors.INVALID_LINES"),
      "errors.TOO_MANY_LINES": t("errors.TOO_MANY_LINES"),
    },
  };

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold text-navy">
        {t("inventory.receiveTransfer")} — {transfer.transferNumber}
      </h1>
      <p className="mb-6 text-sm text-muted">
        {t("inventory.to")}: {transfer.destination.name}
      </p>

      {transfer.status !== "IN_TRANSIT" ? (
        <EmptyState message={t("errors.TRANSFER_NOT_IN_TRANSIT")} />
      ) : (
        <ReceiveTransferForm
          locale={locale}
          transferId={transfer.id}
          transferNumber={transfer.transferNumber}
          destinationName={transfer.destination.name}
          items={transfer.items.map((item) => ({
            itemId: item.id,
            productName: locale === "ar" ? item.product.nameAr : item.product.nameEn,
            shippedQty: item.shippedQty,
          }))}
          labels={labels}
        />
      )}
    </div>
  );
}

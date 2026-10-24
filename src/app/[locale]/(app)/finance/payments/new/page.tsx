import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { PaymentForm, type PaymentFormLabels } from "./PaymentForm";

export default async function NewPaymentPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  // The page itself stays on payments.create so the customer-payment tab —
  // the same capability a SALES_EMPLOYEE already has embedded on
  // /sales/[id] — keeps working. The supplier and transfer tabs are gated
  // FURTHER below, at construction time: their data is only fetched (and the
  // tab only shown) when the caller separately holds purchases.view /
  // finance.manage_accounts. This is UI convenience only — the matching
  // finance/actions.ts actions re-check both permissions server-side, so a
  // raw POST bypassing this page can't reach either capability either.
  requirePermission(ctx, "payments.create", locale);
  const t = await getTranslator(locale);

  const canPaySupplier = can(ctx.role, "purchases.view");
  const canTransfer = can(ctx.role, "finance.manage_accounts");

  const [customers, salesOrders, suppliers, purchaseOrders, accounts] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    // Cancelled orders are excluded here (not just left to the service) so
    // they never even appear in the order picker — recordCustomerPayment
    // rejects them with ORDER_CANCELLED, but a still-listed, unselectable-
    // once-clicked option is a worse UX than not listing it at all.
    // Walk-in sales (customerId null) never carry a receivable to pay.
    prisma.salesOrder.findMany({
      where: { companyId: ctx.companyId, status: { not: "CANCELLED" }, customerId: { not: null } },
      select: { id: true, salesOrderNumber: true, customerId: true, grandTotal: true, paidAmount: true },
      orderBy: { orderDate: "desc" },
    }),
    // Supplier names, every non-cancelled PO's grandTotal/additionalCostTotal/
    // paidAmount — never fetched for a role without purchases.view, so this
    // data literally never reaches the client payload for e.g. a
    // SALES_EMPLOYEE, not just hidden by a tab.
    canPaySupplier
      ? prisma.supplier.findMany({ where: { companyId: ctx.companyId, status: "ACTIVE" }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
    canPaySupplier
      ? prisma.purchaseOrder.findMany({
          where: { companyId: ctx.companyId, status: { not: "CANCELLED" } },
          select: {
            id: true, purchaseOrderNumber: true, supplierId: true,
            grandTotal: true, additionalCostTotal: true, paidAmount: true,
          },
          orderBy: { orderDate: "desc" },
        })
      : Promise.resolve([]),
    prisma.financialAccount.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);

  const labels: PaymentFormLabels = {
    paymentType: t("finance.paymentType"),
    customerPayment: t("finance.customerPayment"), supplierPayment: t("finance.supplierPayment"),
    transfer: t("finance.transfer"),
    customer: t("sales.customer"), supplier: t("purchases.supplier"), order: t("finance.order"),
    account: t("finance.accounts"), fromAccount: t("finance.fromAccount"), toAccount: t("finance.toAccount"),
    amount: t("expenses.amount"), paymentDate: t("purchases.paymentDate"),
    referenceNumber: t("purchases.referenceNumber"), notes: t("suppliers.notes"),
    save: t("finance.recordPayment"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    confirmPaymentTitle: t("purchases.confirmPaymentTitle"),
    confirmCustomerMessageTemplate: t("sales.confirmPaymentMessageTemplate"),
    confirmSupplierMessageTemplate: t("purchases.confirmPaymentMessageTemplate"),
    confirmTransferTitle: t("finance.confirmTransferTitle"),
    confirmTransferMessageTemplate: t("finance.confirmTransferMessageTemplate"),
    remaining: t("purchases.remainingPayable"),
    document: t("expenses.attachAdd"),
    documentHint: t("expenses.attachHint"),
    documentClear: t("expenses.attachRemove"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.AMOUNT_MUST_BE_POSITIVE": t("errors.AMOUNT_MUST_BE_POSITIVE"),
      "errors.ORDER_CANCELLED": t("errors.ORDER_CANCELLED"),
      "errors.ORDER_NOT_CONFIRMED": t("errors.ORDER_NOT_CONFIRMED"),
      "errors.PAYMENT_EXCEEDS_TOTAL": t("errors.PAYMENT_EXCEEDS_TOTAL"),
      "errors.SAME_ACCOUNT": t("errors.SAME_ACCOUNT"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("finance.recordPayment")}</h1>
      <PaymentForm
        locale={locale}
        currency={ctx.currency}
        showSupplierTab={canPaySupplier}
        showTransferTab={canTransfer}
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        salesOrders={salesOrders.map((o) => ({
          id: o.id, orderNumber: o.salesOrderNumber, customerId: o.customerId as string,
          grandTotal: o.grandTotal, paidAmount: o.paidAmount,
        }))}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        purchaseOrders={purchaseOrders.map((o) => ({
          id: o.id, orderNumber: o.purchaseOrderNumber, supplierId: o.supplierId,
          grandTotal: o.grandTotal, additionalCostTotal: o.additionalCostTotal, paidAmount: o.paidAmount,
        }))}
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        labels={labels}
      />
    </div>
  );
}

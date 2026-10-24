import Link from "next/link";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { parseRange } from "@/lib/dateRange";
import { salesSummary } from "@/services/reporting";
import { EmptyState } from "@/components/ui/EmptyState";
import { QuickEntry, type QuickEntryLabels } from "./QuickEntry";

/**
 * `/quick` — the one screen meant to be used on a phone, standing up.
 *
 * Deliberately NOT part of the dashboard: the dashboard analyses, this one
 * enters. It owns no data of its own; every figure on it is read through the
 * same reporting function the dashboard uses, and its one save calls the same
 * server action the full expense form calls.
 */
export default async function QuickPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  // Gated on the strongest permission anything this page can save requires —
  // and `requirePermission`, not `assertCan`, because a denial here is routine
  // and must redirect rather than render a 500 (docs/decisions.md #10).
  requirePermission(ctx, "expenses.create", locale);
  const t = await getTranslator(locale);

  const canViewSales = can(ctx.role, "sales.view");
  // The same permission PAIRS the actions themselves declare: the quick sale
  // is one submit that also posts its payment, and a quick product goes
  // through createProductAction, which pairs products.create with
  // inventory.receive. A button lit by half the pair would refuse when tapped.
  const canSell = can(ctx.role, "sales.create") && can(ctx.role, "payments.create");
  const canCreateProduct = can(ctx.role, "products.create") && can(ctx.role, "inventory.receive");
  // The pair recordSupplierPaymentAction itself declares: payments.create for
  // the write, purchases.view because the handler reads supplier and PO data.
  const canPay = can(ctx.role, "payments.create") && can(ctx.role, "purchases.view");
  const canUndo = can(ctx.role, "expenses.cancel");

  const [categories, account, today, saleProducts, warehouse, suppliers] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { nameEn: "asc" },
    }),
    // The account this page spends from. It is not asked for — that would be
    // a fourth tap on every entry — so the first active one is used and NAMED
    // on screen. A company with several accounts still gets a correct entry,
    // recorded against the account the screen showed.
    prisma.financialAccount.findFirst({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    canViewSales
      ? salesSummary(ctx.companyId, parseRange({ range: "today" }, locale))
      : null,
    // Only what the grid can safely sell: bundles have no shelf of their own
    // (a customer-configured one throws BUNDLE_RECIPE_MISSING mid-sale), and a
    // zero-priced product sold by mis-tap books revenue 0 while depleting real
    // stock. Queried only when the buttons can render, so the catalogue never
    // rides the RSC payload for a role that cannot use it.
    canSell
      ? prisma.product.findMany({
        where: { companyId: ctx.companyId, status: "ACTIVE", isBundle: false, sellingPrice: { gt: 0 } },
        select: { id: true, nameAr: true, nameEn: true, sellingPrice: true },
        orderBy: { nameAr: "asc" },
      })
      : null,
    canSell
      ? prisma.warehouse.findFirst({
        where: { companyId: ctx.companyId, status: "ACTIVE" },
        // The default warehouse is the one Fast Hub syncs against; a quick
        // sale must deplete the same shelf every other sale depletes.
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        select: { id: true },
      })
      : null,
    // Queried only when the payment button can render, same rule as the sale
    // catalogue: the supplier list never rides the RSC payload for a role
    // whose tap would be refused.
    canPay
      ? prisma.supplier.findMany({
        where: { companyId: ctx.companyId, status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
      : null,
  ]);

  // Without these the three taps end on an action that would refuse. Saying so
  // beats a save button that fails after the entry has been typed.
  if (categories.length === 0 || !account) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState message={t("quick.needsSetup")} />
        <p className="mt-4 text-center text-sm">
          <Link className="text-brand underline" href={`/${locale}/expenses/new`}>
            {t("quick.useFullScreen")}
          </Link>
        </p>
      </div>
    );
  }

  const labels: QuickEntryLabels = {
    greeting: t("quick.greeting"), salesToday: t("dashboard.salesToday"),
    expense: t("quick.expense"), expenseHint: t("quick.expenseHint"),
    sale: t("quick.sale"), saleHint: t("quick.saleHint"),
    product: t("quick.product"), productHint: t("quick.productHint"),
    payment: t("quick.payment"), paymentHint: t("quick.paymentHint"),
    soon: t("quick.soon"), newExpense: t("quick.newExpense"), next: t("quick.next"),
    category: t("expenses.category"), invoice: t("quick.invoice"),
    optional: t("quick.optional"), snap: t("quick.snap"), snapDone: t("quick.snapDone"),
    snapClear: t("expenses.attachRemove"), save: t("quick.save"), saving: t("app.loading"),
    back: t("app.back"), saved: t("quick.saved"),
    fromTemplate: t("quick.fromTemplate"),
    newSale: t("quick.newSale"), total: t("quick.total"), recordSale: t("quick.recordSale"),
    newProduct: t("quick.newProduct"), productName: t("quick.productName"),
    productPrice: t("quick.productPrice"), saveProduct: t("quick.saveProduct"),
    productLater: t("quick.productLater"),
    newPayment: t("quick.newPayment"), payTo: t("quick.payTo"),
    savePayment: t("quick.savePayment"),
    undo: t("quick.undo"), undone: t("quick.undone"), undoReason: t("quick.undoReason"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.AMOUNT_MUST_BE_POSITIVE": t("errors.AMOUNT_MUST_BE_POSITIVE"),
      "errors.INVALID_TAX_AMOUNT": t("errors.INVALID_TAX_AMOUNT"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.INSUFFICIENT_STOCK": t("errors.INSUFFICIENT_STOCK"),
      "errors.NO_LINES": t("errors.NO_LINES"),
      "errors.DUPLICATE_SKU": t("errors.DUPLICATE_SKU"),
    },
  };

  return (
    <QuickEntry
      locale={locale}
      currency={ctx.currency}
      categories={categories}
      accountId={account.id}
      accountName={account.name}
      sale={
        saleProducts && warehouse && saleProducts.length > 0
          ? { warehouseId: warehouse.id, products: saleProducts }
          : undefined
      }
      productEntry={canCreateProduct}
      payment={suppliers && suppliers.length > 0 ? { suppliers } : undefined}
      canUndo={canUndo}
      today={
        today
          ? {
            revenue: today.revenue,
            // A raw NUMBER on purpose. `count` is the one var the translator
            // formats itself (Arabic-Indic digits), and it is also the value
            // `Intl.PluralRules` selects the category from — pre-formatting it
            // to a string would silently collapse طلبان/طلبات into "other".
            ordersLabel: t("dashboard.orders", { count: today.orderCount }),
          }
          : undefined
      }
      labels={labels}
    />
  );
}

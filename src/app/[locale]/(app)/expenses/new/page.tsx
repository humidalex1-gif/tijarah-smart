import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { ExpenseForm, type ExpenseFormLabels } from "../ExpenseForm";

export default async function NewExpensePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "expenses.create", locale);
  const t = await getTranslator(locale);

  const [categories, accounts, suppliers, warehouses] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { nameEn: "asc" },
    }),
    prisma.financialAccount.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    prisma.supplier.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    prisma.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);

  const labels: ExpenseFormLabels = {
    category: t("expenses.category"), amount: t("expenses.amount"), tax: t("expenses.tax"),
    date: t("expenses.date"), account: t("finance.accounts"), supplier: t("expenses.supplier"),
    warehouse: t("expenses.warehouse"), description: t("expenses.description"), notes: t("expenses.notes"),
    save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    createConfirmTitle: t("expenses.createConfirmTitle"),
    createConfirmMessageTemplate: t("expenses.createConfirmMessageTemplate"),
    document: t("expenses.attachAdd"),
    documentHint: t("expenses.attachHint"),
    documentClear: t("expenses.attachRemove"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.AMOUNT_MUST_BE_POSITIVE": t("errors.AMOUNT_MUST_BE_POSITIVE"),
      "errors.INVALID_TAX_AMOUNT": t("errors.INVALID_TAX_AMOUNT"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("expenses.add")}</h1>
      <ExpenseForm
        locale={locale}
        currency={ctx.currency}
        categories={categories}
        accounts={accounts}
        suppliers={suppliers}
        warehouses={warehouses}
        labels={labels}
      />
    </div>
  );
}

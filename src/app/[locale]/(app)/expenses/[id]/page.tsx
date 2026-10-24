import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatBusinessDate, formatMoney } from "@/lib/format";
import { Money } from "@/components/ui/Money";
import { PageSection } from "@/components/ui/PageSection";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { listAttachments } from "@/lib/uploads";
import { ExpenseDetailActions, type ExpenseDetailActionsLabels } from "./ExpenseDetailActions";
import { Attachments } from "./Attachments";

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "expenses.view", locale);
  const t = await getTranslator(locale);

  // findFirst (never findUniqueOrThrow) with an explicit companyId filter —
  // same tenant-boundary rule as every other Task 5-9 detail page.
  const expense = await prisma.expense.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      category: { select: { nameAr: true, nameEn: true } },
      account: { select: { name: true } },
      supplier: { select: { name: true } },
    },
  });
  if (!expense) notFound();

  const warehouse = expense.warehouseId
    ? await prisma.warehouse.findFirst({
        where: { id: expense.warehouseId, companyId: ctx.companyId },
        select: { name: true },
      })
    : null;

  const canCancel = can(ctx.role, "expenses.cancel") && expense.status !== "CANCELLED";
  // Read here, for this expense, so what is on screen is what is stored —
  // not an empty list the client then has to discover.
  const attachments = await listAttachments(ctx, "EXPENSE", expense.id);
  const totalDisplay = formatMoney(expense.totalAmount, locale, ctx.currency);

  const labels: ExpenseDetailActionsLabels = {
    cancel: t("expenses.cancel"), cancelReason: t("expenses.cancelReason"),
    cancelTitle: t("expenses.cancelTitle"),
    cancelMessage: t("expenses.cancelMessageTemplate", {
      number: expense.expenseNumber,
      amount: totalDisplay,
      account: expense.account.name,
    }),
    dismiss: t("app.cancel"), confirm: t("app.confirm"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.REASON_REQUIRED": t("errors.REASON_REQUIRED"),
      "errors.ALREADY_CANCELLED": t("errors.ALREADY_CANCELLED"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
    },
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">{expense.expenseNumber}</h1>
          <p className="text-sm text-muted">
            {locale === "ar" ? expense.category.nameAr : expense.category.nameEn} · {formatBusinessDate(expense.expenseDate, locale)}
          </p>
          <div className="mt-1">
            <StatusBadge
              label={t(`status.${expense.status}`)}
              tone={expense.status === "CANCELLED" ? "danger" : "success"}
            />
          </div>
        </div>
        <ExpenseDetailActions expenseId={expense.id} canCancel={canCancel} labels={labels} />
      </div>

      <PageSection title={t("expenses.overview")}>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">{t("expenses.amount")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={expense.amount} locale={locale} currency={ctx.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("expenses.tax")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={expense.taxAmount} locale={locale} currency={ctx.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("expenses.total")}</div>
            <div className="mt-1 text-lg font-semibold"><Money minor={expense.totalAmount} locale={locale} currency={ctx.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{t("expenses.paidFrom")}</div>
            <div className="mt-1 text-lg font-semibold">{expense.account.name}</div>
          </div>
        </div>
      </PageSection>

      {expense.status !== "CANCELLED" ? (
        <PageSection>
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
            {t("expenses.impactTemplate", { account: expense.account.name, amount: totalDisplay })}
          </p>
        </PageSection>
      ) : null}

      <PageSection title={t("expenses.description")}>
        <p className="text-sm">{expense.description}</p>
      </PageSection>

      {/* The invoice behind the figure. It was attachable from the create
          form and stored, but for a month nothing on this page showed it —
          the only way to it was the finance transactions list. */}
      <PageSection title={t("expenses.documents")}>
        <Attachments
          expenseId={expense.id}
          locale={locale}
          initial={attachments}
          labels={{
            add: t("expenses.attachAdd"), adding: t("expenses.attachAdding"),
            hint: t("expenses.attachHint"), none: t("expenses.attachNone"),
            remove: t("expenses.attachRemove"), removing: t("expenses.attachRemoving"),
            open: t("expenses.attachOpen"), generic: t("errors.generic"),
          }}
        />
      </PageSection>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {expense.supplier ? (
          <div>
            <div className="text-xs text-muted">{t("expenses.supplier")}</div>
            <div className="mt-1 text-sm font-medium">{expense.supplier.name}</div>
          </div>
        ) : null}
        {warehouse ? (
          <div>
            <div className="text-xs text-muted">{t("expenses.warehouse")}</div>
            <div className="mt-1 text-sm font-medium">{warehouse.name}</div>
          </div>
        ) : null}
      </div>

      {expense.notes ? (
        <PageSection title={t("expenses.notes")}>
          <p className="whitespace-pre-wrap text-sm text-muted">{expense.notes}</p>
        </PageSection>
      ) : null}
    </div>
  );
}

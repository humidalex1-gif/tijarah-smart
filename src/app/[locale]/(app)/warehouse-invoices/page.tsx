import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { formatBusinessDate, formatMoney, formatNumber } from "@/lib/format";
import { PageHelp } from "@/components/ui/PageHelp";
import { EmptyState } from "@/components/ui/EmptyState";
import { InvoiceUpload } from "./InvoiceUpload";

/**
 * The warehouse's own bill, checked before it is believed.
 *
 * Fast Hub's charges are per-order fulfilment fees and monthly storage — never
 * a cost of the goods — so this screen exists to route them to two different
 * places and to re-derive their arithmetic on the way.
 */
export default async function WarehouseInvoicesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  // BOTH halves of the pair the actions themselves declare
  // (["expenses.create", "sales.edit"] in actions.ts). Gating on half let an
  // ACCOUNTANT open a fully live upload screen whose every submit returned
  // FORBIDDEN after the work of filling it — the exact defect the quick page
  // documents avoiding. requirePermission redirects, so each call is a gate.
  requirePermission(ctx, "expenses.create", locale);
  requirePermission(ctx, "sales.edit", locale);
  const t = await getTranslator(locale);

  const [categories, accounts, invoices] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { companyId: ctx.companyId },
      orderBy: { nameEn: "asc" },
    }),
    prisma.financialAccount.findMany({
      where: { companyId: ctx.companyId },
      orderBy: { name: "asc" },
    }),
    prisma.warehouseInvoice.findMany({
      where: { companyId: ctx.companyId },
      orderBy: { invoiceDate: "desc" },
      take: 24,
      include: { _count: { select: { lines: true } } },
    }),
  ]);

  // With the currency: this is the one screen where Fast Hub's stated total is
  // compared against the books, and it was the only money in the app printed
  // as a bare number.
  const money = (minor: number) => formatMoney(minor, locale, ctx.currency);

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-muted">{t("whInvoice.intro")}</p>
      </div>

      <PageHelp t={t} pageKey="whInvoice" />

      {categories.length === 0 || accounts.length === 0 ? (
        // Posting needs somewhere to put the storage cost. Saying so beats an
        // upload that reads the file and then fails at the last step.
        <p className="rounded-xl border border-warning bg-warning-soft p-4 text-sm text-navy">
          {t("whInvoice.needsSetup")}
        </p>
      ) : (
        <InvoiceUpload
          locale={locale}
          currency={ctx.currency}
          categories={categories.map((c) => ({
            id: c.id, name: locale === "ar" ? c.nameAr : c.nameEn,
          }))}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          labels={{
            upload: t("whInvoice.upload"),
            uploadHint: t("whInvoice.uploadHint"),
            reading: t("whInvoice.reading"),
            post: t("whInvoice.post"),
            posting: t("whInvoice.posting"),
            posted: t("whInvoice.posted"),
            invoiceNumber: t("whInvoice.invoiceNumber"),
            invoiceNumberHint: t("whInvoice.invoiceNumberHint"),
            category: t("whInvoice.category"),
            account: t("whInvoice.account"),
            orderFees: t("whInvoice.orderFees"),
            storage: t("whInvoice.storage"),
            subtotal: t("whInvoice.subtotal"),
            tax: t("whInvoice.tax"),
            total: t("whInvoice.total"),
            order: t("whInvoice.order"),
            matched: t("whInvoice.matched"),
            notMatched: t("whInvoice.notMatched"),
            issues: t("whInvoice.issues"),
            noIssues: t("whInvoice.noIssues"),
            unbilled: t("whInvoice.unbilled"),
            packaging: t("whInvoice.packaging"),
            handling: t("whInvoice.handling"),
            shipping: t("whInvoice.shipping"),
            extraPieces: t("whInvoice.extraPieces"),
            generic: t("errors.generic"),
          }}
          issueLabels={{
            ORDER_NOT_IN_BOOKS: t("whInvoice.issueOrderNotInBooks"),
            ORDER_BILLED_TWICE: t("whInvoice.issueBilledTwice"),
            ORDER_NOT_CONFIRMED: t("whInvoice.issueNotConfirmed"),
            EXTRA_PIECES_WRONG: t("whInvoice.issueExtraPieces"),
            ORDER_FEES_DO_NOT_ADD_UP: t("whInvoice.issueFeesDoNotAdd"),
            SUBTOTAL_DOES_NOT_MATCH_LINES: t("whInvoice.issueSubtotal"),
            TAX_DOES_NOT_MATCH_SUBTOTAL: t("whInvoice.issueTax"),
          }}
          problemLabels={{
            NO_WORKBOOK: t("whInvoice.problemNoWorkbook"),
            TOO_MANY_WORKBOOKS: t("whInvoice.problemTooManyWorkbooks"),
            UNSUPPORTED_FILE: t("whInvoice.problemUnsupportedFile"),
          }}
        />
      )}

      <div className="rounded-xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold">{t("whInvoice.history")}</h2>
        {invoices.length === 0 ? (
          <div className="mt-3"><EmptyState message={t("whInvoice.empty")} /></div>
        ) : (
          <ul className="mt-3 space-y-2">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3 text-sm">
                <span>
                  <span className="font-medium">{invoice.invoiceNumber}</span>{" "}
                  <span className="text-muted">{formatBusinessDate(invoice.invoiceDate, locale)}</span>
                </span>
                <span className="text-muted">
                  {formatNumber(invoice._count.lines, locale)} · {money(invoice.total)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { NextResponse } from "next/server";
import { loadAppContext } from "@/lib/appContext";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { toCsv, CSV_BOM, type CsvCell } from "@/lib/csv";
import { LIVE_ORDER_STATUSES } from "@/services/reporting";

/**
 * CSV downloads of what the list screens already show — for the accountant's
 * Excel, not for any new report of ours.
 *
 * Read-only by construction, and the columns obey the same permission the
 * screens do: profit columns exist only for a role holding
 * `finance.view_profit`, because a download link pasted into a chat must not
 * carry figures the screen itself would hide (rule 4's spirit: gate at
 * construction, not at display).
 *
 * Money is exported as plain decimals ("259.50") and dates as ISO days: a
 * spreadsheet sums the first and sorts the second, and localized digits
 * would turn both into strings.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; kind: string }> },
) {
  const { locale: rawLocale, kind } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  // Redirects to login with no session, like every screen.
  const ctx = await loadAppContext(locale);

  const money = (minor: number) => (minor / 100).toFixed(2);
  const day = (d: Date) => d.toISOString().slice(0, 10);

  if (kind === "sales") {
    if (!can(ctx.role, "sales.view")) return new NextResponse(null, { status: 403 });
    const withProfit = can(ctx.role, "finance.view_profit");

    const orders = await prisma.salesOrder.findMany({
      where: { companyId: ctx.companyId, status: { in: LIVE_ORDER_STATUSES } },
      select: {
        salesOrderNumber: true, orderDate: true, status: true, channel: true,
        subtotal: true, shippingCharged: true, refundedAmount: true, grandTotal: true,
        grossProfit: true, netProfit: true,
        customer: { select: { name: true } },
      },
      orderBy: { salesOrderNumber: "asc" },
    });

    const headers = [
      "order", "date", "status", "channel", "customer",
      "subtotal", "shipping", "refunded", "grand_total",
      ...(withProfit ? ["gross_profit", "net_profit"] : []),
    ];
    const rows: CsvCell[][] = orders.map((o) => [
      o.salesOrderNumber, day(o.orderDate), o.status, o.channel ?? "", o.customer?.name ?? "",
      money(o.subtotal), money(o.shippingCharged), money(o.refundedAmount), money(o.grandTotal),
      ...(withProfit ? [money(o.grossProfit), money(o.netProfit)] : []),
    ]);
    return csvResponse("sales.csv", toCsv(headers, rows));
  }

  if (kind === "expenses") {
    if (!can(ctx.role, "expenses.view")) return new NextResponse(null, { status: 403 });

    const expenses = await prisma.expense.findMany({
      where: { companyId: ctx.companyId },
      select: {
        expenseNumber: true, expenseDate: true, status: true, description: true,
        amount: true, taxAmount: true, totalAmount: true,
        category: { select: { nameAr: true, nameEn: true } },
      },
      orderBy: { expenseNumber: "asc" },
    });

    const headers = ["expense", "date", "status", "category", "description", "amount", "tax", "total"];
    const rows: CsvCell[][] = expenses.map((e) => [
      e.expenseNumber, day(e.expenseDate), e.status,
      locale === "ar" ? e.category.nameAr : e.category.nameEn,
      e.description, money(e.amount), money(e.taxAmount), money(e.totalAmount),
    ]);
    return csvResponse("expenses.csv", toCsv(headers, rows));
  }

  // An unknown kind is a typo'd URL, not a crash.
  return new NextResponse(null, { status: 404 });
}

function csvResponse(filename: string, csv: string): NextResponse {
  return new NextResponse(CSV_BOM + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${filename}`,
      "Cache-Control": "private, no-store",
    },
  });
}

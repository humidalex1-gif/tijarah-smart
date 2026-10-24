import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { recomputeOrderCostAllocation } from "@/services/sales";
import { addExpense } from "@/services/expenses";
import { writeAudit } from "@/services/audit";
import { invalidState } from "@/services/errors";
import type { VerifiedWarehouseInvoice } from "@/services/warehouseInvoice/verify";

/**
 * Books the warehouse's bill, splitting it by where each charge belongs.
 *
 * The split is the entire point, and getting it wrong is the risk:
 *
 * - **Per-order fees** — packaging, handling, shipping, extra pieces — attach
 *   to the order that caused them, and land in NET profit. They are not part
 *   of the cost of the goods: folding them into `avgCost` would raise the
 *   value of every unit still on the shelf on the strength of a bill for units
 *   that already left it.
 * - **Storage** is a cost of the month, not of any order. Spreading it over
 *   the orders that happened to ship would make a quiet month look profitable
 *   and a busy one ruinous.
 *
 * Nothing is charged to an order the books could not match. The line is still
 * recorded — what the warehouse billed is a fact worth keeping even when our
 * matching fails — it simply moves no money.
 */

/** The invoice's shipping column is delivery; the other three are handling. */
const SHIPPING = "SHIPPING";
const HANDLING = "OTHER";

export type PostedWarehouseInvoice = {
  invoiceId: string;
  ordersCharged: number;
  /** Minor units of per-order fees actually charged to orders. */
  orderFeesPosted: number;
  storagePosted: number;
  storageExpenseIds: string[];
  /** Billed order numbers with no order in the books. */
  unmatched: string[];
};

export async function postWarehouseInvoice(
  ctx: ServiceContext,
  input: {
    verified: VerifiedWarehouseInvoice;
    invoiceNumber: string;
    expenseCategoryId: string;
    expenseAccountId: string;
    /** The workbook that was parsed. */
    attachmentId?: string | null;
    /** Fast Hub's PDF — the invoice document proper, kept but never parsed. */
    documentAttachmentId?: string | null;
  },
): Promise<PostedWarehouseInvoice> {
  const { verified } = input;
  const { parsed } = verified;

  const existing = await prisma.warehouseInvoice.findFirst({
    where: { companyId: ctx.companyId, source: "FASTHUB", invoiceNumber: input.invoiceNumber },
    select: { id: true },
  });
  if (existing) {
    // Caught before anything is written rather than left to the unique index,
    // so a second upload cannot post half an invoice before it collides.
    throw invalidState("WAREHOUSE_INVOICE_ALREADY_POSTED", { invoiceNumber: input.invoiceNumber });
  }

  // The preview shows issues; this is the gate. ORDER_BILLED_TWICE would
  // charge an order two fee sets, and ORDER_NOT_CONFIRMED means a draft the
  // books must resolve BEFORE its fees can attach — posting past either is
  // how an invoice ends up half-charged, the state this module's own comment
  // calls worse than not charging at all.
  const blocking = input.verified.issues.filter(
    (issue) => issue.kind === "ORDER_BILLED_TWICE" || issue.kind === "ORDER_NOT_CONFIRMED",
  );
  if (blocking.length > 0) {
    throw invalidState("INVOICE_ISSUES_BLOCK_POSTING", {
      issues: blocking.map((issue) => `${issue.kind}:${"ref" in issue ? issue.ref : ""}`),
    });
  }

  const matched = verified.orders.filter((o) => o.salesOrderId !== null);
  const unmatched = verified.orders
    .filter((o) => o.salesOrderId === null)
    .map((o) => o.line.externalOrderRef);

  // The invoice, its lines and every order-cost row commit together: a bill
  // half-charged across seven orders is worse than one not charged at all,
  // because only the second is obvious.
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.warehouseInvoice.create({
      data: {
        companyId: ctx.companyId,
        source: "FASTHUB",
        invoiceNumber: input.invoiceNumber,
        invoiceDate: parsed.invoiceDate,
        subtotal: parsed.subtotal,
        taxAmount: parsed.taxAmount,
        total: parsed.total,
        status: "POSTED",
        postedAt: new Date(),
      },
    });

    for (const order of verified.orders) {
      const { line } = order;
      await tx.warehouseInvoiceLine.create({
        data: {
          companyId: ctx.companyId,
          invoiceId: created.id,
          kind: "ORDER_FEE",
          externalOrderRef: line.externalOrderRef,
          salesOrderId: order.salesOrderId,
          description:
            `تغليف ${line.packagingFee / 100} · تجهيز ${line.handlingFee / 100} · `
            + `شحن ${line.shippingFee / 100} · قطع إضافية ${line.extraPieceFee / 100}`,
          quantity: line.weightKg,
          amount: line.totalBeforeTax,
          taxAmount: line.taxAmount,
        },
      });

      if (!order.salesOrderId) continue;

      // Two rows, not four: shipping is delivery and belongs in its own
      // column of the profit waterfall, the rest is handling.
      const handling = line.packagingFee + line.handlingFee + line.extraPieceFee;
      if (line.shippingFee > 0) {
        await tx.salesOrderCost.create({
          data: {
            salesOrderId: order.salesOrderId,
            costType: SHIPPING,
            description: `فاست هب ${input.invoiceNumber} — الشحن والتوصيل`,
            amount: line.shippingFee,
          },
        });
      }
      if (handling > 0) {
        await tx.salesOrderCost.create({
          data: {
            salesOrderId: order.salesOrderId,
            costType: HANDLING,
            description: `فاست هب ${input.invoiceNumber} — تغليف وتجهيز وقطع إضافية`,
            amount: handling,
          },
        });
      }
    }

    await writeAudit(tx, ctx, {
      action: "WAREHOUSE_INVOICE_POSTED",
      entityType: "WarehouseInvoice",
      entityId: created.id,
      newValues: {
        invoiceNumber: input.invoiceNumber,
        subtotal: parsed.subtotal,
        ordersCharged: matched.length,
        unmatched,
      },
    });

    return created;
  });

  // Both halves of the bill hang off the invoice: the workbook that was parsed
  // and the PDF that was not. Tenant-scoped in the WHERE, so an id from another
  // company resolves to no rows rather than being re-parented into this one.
  const attachmentIds = [input.attachmentId, input.documentAttachmentId]
    .filter((id): id is string => Boolean(id));
  if (attachmentIds.length > 0) {
    await prisma.attachment.updateMany({
      where: { id: { in: attachmentIds }, companyId: ctx.companyId },
      data: { entityType: "WAREHOUSE_INVOICE", entityId: invoice.id },
    });
  }

  // Outside the transaction above: each recompute opens its own, and Prisma
  // does not nest them. The cost rows are already committed, so a failure here
  // leaves figures that a re-run of the recompute corrects — it cannot lose
  // the charge itself.
  for (const order of matched) {
    await recomputeOrderCostAllocation(ctx, order.salesOrderId!);
  }

  const storageExpenseIds: string[] = [];
  let storagePosted = 0;
  for (const line of verified.storage) {
    if (line.amount <= 0) continue;
    const expense = await addExpense(ctx, {
      categoryId: input.expenseCategoryId,
      accountId: input.expenseAccountId,
      expenseDate: parsed.invoiceDate,
      description: `${line.description} — فاست هب ${input.invoiceNumber}`,
      amount: line.amount,
    });
    storageExpenseIds.push(expense.expenseId);
    storagePosted += line.amount;
    await prisma.warehouseInvoiceLine.create({
      data: {
        companyId: ctx.companyId,
        invoiceId: invoice.id,
        kind: "STORAGE",
        expenseId: expense.expenseId,
        description: line.description,
        quantity: line.quantity,
        amount: line.amount,
      },
    });
  }

  return {
    invoiceId: invoice.id,
    ordersCharged: matched.length,
    orderFeesPosted: matched.reduce((sum, o) => sum + o.line.totalBeforeTax, 0),
    storagePosted,
    storageExpenseIds,
    unmatched,
  };
}

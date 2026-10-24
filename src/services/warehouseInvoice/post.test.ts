import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual } from "@/services/stock";
import { createSalesOrder, confirmSale } from "@/services/sales";
import { parseFastHubInvoice } from "@/services/warehouseInvoice/parse";
import { verifyWarehouseInvoice } from "@/services/warehouseInvoice/verify";
import { postWarehouseInvoice } from "@/services/warehouseInvoice/post";
import {
  makeCompany, makeWarehouse, makeProduct, makeCtx, makeAccount,
  makeExpenseCategory, resetDb,
} from "../../../tests/factories";

/**
 * Posting splits the bill by WHERE each charge belongs. Getting that split
 * wrong is the whole risk: fulfilment fees folded into unit cost would raise
 * the value of every unit still on the shelf, and storage charged to an order
 * would make a quiet month look profitable and a busy one ruinous.
 */

const workbook = () => readFileSync("tests/fixtures-invoice.xlsx");

/** The seven order numbers Fast Hub billed on the 2026-08-02 invoice. */
const BILLED = [
  "551614928", "1360405922", "1699811234",
  "605050236", "1063315702", "141085494", "111462246",
];

async function setup(refs: string[] = BILLED) {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id);
  const account = await makeAccount(company.id);
  const category = await makeExpenseCategory(company.id, "Warehouse");

  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(200), unitCost: toCost(toMinor(10)),
  });

  const orderIds = new Map<string, string>();
  for (const ref of refs) {
    const { salesOrderId } = await createSalesOrder(ctx, {
      warehouseId: warehouse.id,
      channel: "FASTHUB",
      orderDate: new Date("2026-07-20T00:00:00Z"),
      items: [{ productId: product.id, quantity: toQty(2), unitPrice: toMinor(100) }],
    });
    await confirmSale(ctx, { salesOrderId });
    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { externalSource: "FASTHUB", externalRef: ref, externalKey: `FASTHUB:${ref}` },
    });
    orderIds.set(ref, salesOrderId);
  }

  return { company, ctx, warehouse, account, category, orderIds };
}

async function verified(ctx: ReturnType<typeof makeCtx>) {
  return verifyWarehouseInvoice(ctx, await parseFastHubInvoice(workbook()));
}

describe("postWarehouseInvoice", () => {
  beforeEach(resetDb);

  it("charges each order its own fees and leaves storage out of them", async () => {
    const { ctx, account, category, orderIds } = await setup();

    const result = await postWarehouseInvoice(ctx, {
      verified: await verified(ctx),
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
    });

    expect(result.ordersCharged).toBe(7);
    // 115.50 of per-order fees across the seven, never 335.50.
    expect(result.orderFeesPosted).toBe(toMinor(115.5));

    // The heaviest order on the invoice: 2 packaging + 4 handling + 10
    // shipping + 2 extra pieces.
    const costs = await prisma.salesOrderCost.findMany({
      where: { salesOrderId: orderIds.get("111462246") },
    });
    expect(costs.reduce((s, c) => s + c.amount, 0)).toBe(toMinor(18));
  });

  it("moves the order's net profit, and never its gross profit or unit cost", async () => {
    // The distinction the whole split exists for: a fulfilment fee is not part
    // of the cost of the goods, so it must not raise the value of the units
    // still sitting on the shelf.
    const { ctx, account, category, orderIds } = await setup();
    const id = orderIds.get("111462246")!;
    const before = await prisma.salesOrder.findUniqueOrThrow({ where: { id } });

    await postWarehouseInvoice(ctx, {
      verified: await verified(ctx),
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
    });

    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id } });
    expect(after.netProfit).toBe(before.netProfit - toMinor(18));
    expect(after.grossProfit).toBe(before.grossProfit);
    expect(after.totalCost).toBe(before.totalCost);
  });

  it("books storage as an expense of the period, charged to no order", async () => {
    const { ctx, account, category } = await setup();

    const result = await postWarehouseInvoice(ctx, {
      verified: await verified(ctx),
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
    });

    const expense = await prisma.expense.findUniqueOrThrow({
      where: { id: result.storageExpenseIds[0] },
    });
    expect(expense.amount).toBe(toMinor(220));
    expect(result.storagePosted).toBe(toMinor(220));
  });

  it("records an order it could not match without charging anyone for it", async () => {
    const { ctx, account, category } = await setup(BILLED.filter((r) => r !== "111462246"));

    const result = await postWarehouseInvoice(ctx, {
      verified: await verified(ctx),
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
    });

    expect(result.ordersCharged).toBe(6);
    expect(result.unmatched).toEqual(["111462246"]);
    // The line is kept: the invoice said it, and the record of what they
    // billed must survive our inability to match it.
    const line = await prisma.warehouseInvoiceLine.findFirstOrThrow({
      where: { externalOrderRef: "111462246" },
    });
    expect(line.salesOrderId).toBeNull();
  });

  it("refuses the same invoice number twice, so no order is charged twice", async () => {
    const { ctx, account, category } = await setup();
    const input = {
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
    };

    await postWarehouseInvoice(ctx, { ...input, verified: await verified(ctx) });

    await expect(
      postWarehouseInvoice(ctx, { ...input, verified: await verified(ctx) }),
    ).rejects.toThrow();

    expect(await prisma.warehouseInvoice.count()).toBe(1);
    expect(await prisma.expense.count()).toBe(1);
  });

  /**
   * Fast Hub's bill arrives as a pair, and both halves belong on the record:
   * the workbook is what was parsed, the PDF is the document proper. Keeping
   * only the workbook would leave the posted invoice with no copy of the thing
   * the warehouse actually issued.
   */
  it("keeps both the workbook and the PDF on the posted invoice", async () => {
    const { ctx, company, account, category } = await setup();

    const attach = async (fileName: string, storedName: string) =>
      prisma.attachment.create({
        data: {
          companyId: company.id,
          entityType: "WAREHOUSE_INVOICE",
          entityId: "",
          fileName,
          storedName,
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        },
      });

    const workbookFile = await attach("Invoice_Sokudry_2026-08-02.xlsx", "stored-workbook");
    const documentFile = await attach("متجر سوكودراي-فاتورة رقم 211-يوليو.pdf", "stored-document");

    const result = await postWarehouseInvoice(ctx, {
      verified: await verified(ctx),
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
      attachmentId: workbookFile.id,
      documentAttachmentId: documentFile.id,
    });

    const linked = await prisma.attachment.findMany({
      where: { entityType: "WAREHOUSE_INVOICE", entityId: result.invoiceId },
      orderBy: { fileName: "asc" },
      select: { id: true },
    });

    expect(linked.map((a) => a.id).sort()).toEqual([workbookFile.id, documentFile.id].sort());
  });

  it("refuses to post while the verification carries blocking issues", async () => {
    // ORDER_BILLED_TWICE double-charges and ORDER_NOT_CONFIRMED half-posts;
    // both were previewable chips a hurried tap could sail past. Posting now
    // refuses outright — the preview is information, this is the gate.
    const { ctx, account, category } = await setup(BILLED.filter((r) => r !== "111462246"));
    // The seventh billed order exists — as a DRAFT. Matching it used to slip
    // through and detonate after commit; now it is a blocking issue.
    await prisma.salesOrder.create({
      data: {
        companyId: ctx.companyId,
        salesOrderNumber: "SO-DRAFT",
        status: "DRAFT",
        warehouseId: (await prisma.warehouse.findFirstOrThrow()).id,
        externalSource: "FASTHUB", externalRef: "111462246", externalKey: "FASTHUB:111462246",
        orderDate: new Date("2026-07-20T00:00:00Z"),
      },
    });

    await expect(postWarehouseInvoice(ctx, {
      verified: await verified(ctx),
      invoiceNumber: "211",
      expenseCategoryId: category.id,
      expenseAccountId: account.id,
    })).rejects.toMatchObject({ code: "INVOICE_ISSUES_BLOCK_POSTING" });

    // Nothing committed: no invoice row, no cost rows, no expenses.
    expect(await prisma.warehouseInvoice.count()).toBe(0);
    expect(await prisma.salesOrderCost.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });
});

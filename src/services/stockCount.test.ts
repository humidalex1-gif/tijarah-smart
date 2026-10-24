import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual, issueStock } from "@/services/stock";
import {
  createStockCount, recordCount, requestRecount, submitForReview, cancelStockCount,
  postStockCount,
} from "@/services/stockCount";
import {
  makeCompany, makeWarehouse, makeProduct, makeProductVariant, makeCategory, makeCtx, resetDb,
} from "../../tests/factories";

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const product = await makeProduct(company.id);
  const ctx = makeCtx(company.id);
  return { company, warehouse, product, ctx };
}

async function stocked(qty = 10) {
  const s = await setup();
  await receiveStockManual(s.ctx, {
    warehouseId: s.warehouse.id, productId: s.product.id,
    quantity: toQty(qty), unitCost: toCost(toMinor(30)),
  });
  return s;
}

describe("createStockCount", () => {
  beforeEach(resetDb);

  it("creates a numbered session with one snapshot line per stocked product", async () => {
    const { warehouse, product, ctx } = await stocked(10);

    const result = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });

    expect(result.countNumber).toBe("CNT-0001");
    expect(result.lineCount).toBe(1);

    const line = await prisma.stockCountLine.findFirstOrThrow();
    expect(line.productId).toBe(product.id);
    expect(line.snapshotQty).toBe(toQty(10));
    expect(line.countedQty).toBeNull();
    expect(line.variantKey).toBe("");

    const session = await prisma.stockCountSession.findFirstOrThrow();
    expect(session.status).toBe("OPEN");
    expect(await prisma.auditLog.count()).toBe(2); // the receipt, then this
  });

  it("includes a product with no balance row at a snapshot of zero", async () => {
    // Finding stock on a shelf the system believes is empty is a real
    // result, so a product with no InventoryBalance row is still countable.
    const { warehouse, ctx } = await setup();
    await makeProduct(ctx.companyId, { sku: "NOSTOCK" });

    const result = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });

    expect(result.lineCount).toBe(2);
    const zeroLine = await prisma.stockCountLine.findFirstOrThrow({
      where: { product: { sku: "NOSTOCK" } },
    });
    expect(zeroLine.snapshotQty).toBe(0);
  });

  it("refuses a scope that matches nothing rather than creating an empty session", async () => {
    const { warehouse, ctx } = await setup();

    await expect(createStockCount(ctx, {
      warehouseId: warehouse.id,
      scope: { scopeType: "MANUAL", productIds: [] },
    })).rejects.toMatchObject({ code: "COUNT_EMPTY_SCOPE" });

    expect(await prisma.stockCountSession.count()).toBe(0);
  });

  it("refuses a warehouse belonging to another company", async () => {
    const { ctx } = await setup();
    const other = await makeCompany("Other Co");
    const otherWarehouse = await makeWarehouse(other.id, "OTHER");

    await expect(createStockCount(ctx, {
      warehouseId: otherWarehouse.id, scope: { scopeType: "WAREHOUSE" },
    })).rejects.toThrow();

    expect(await prisma.stockCountSession.count()).toBe(0);
  });

  it("excludes archived products", async () => {
    const { warehouse, ctx } = await stocked(10);
    const archived = await makeProduct(ctx.companyId, { sku: "OLD" });
    await prisma.product.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });

    const result = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });

    expect(result.lineCount).toBe(1);
  });

  // ProductCategory is a tree, and a CATEGORY scope used to match categoryId
  // exactly — so a count scoped to "Beverages" silently excluded everything
  // filed under "Beverages > Soft drinks". Worse than a miscount: each
  // excluded product was then reported as "not counted", which reads as the
  // counter having skipped it rather than the scope never having covered it.
  it("covers products in child categories, not only the category named", async () => {
    const { warehouse, ctx } = await setup();
    const beverages = await makeCategory(ctx.companyId, "Beverages");
    const softDrinks = await makeCategory(ctx.companyId, "Soft drinks", beverages.id);
    const snacks = await makeCategory(ctx.companyId, "Snacks");

    await makeProduct(ctx.companyId, { sku: "JUICE", categoryId: beverages.id });
    await makeProduct(ctx.companyId, { sku: "COLA", categoryId: softDrinks.id });
    await makeProduct(ctx.companyId, { sku: "CRISPS", categoryId: snacks.id });

    const result = await createStockCount(ctx, {
      warehouseId: warehouse.id,
      scope: { scopeType: "CATEGORY", categoryId: beverages.id },
    });

    expect(result.lineCount).toBe(2);
    const skus = (await prisma.stockCountLine.findMany({
      include: { product: { select: { sku: true } } },
    })).map((l) => l.product.sku).sort();
    expect(skus).toEqual(["COLA", "JUICE"]);
  });

  it("does not let a category scope reach another company's tree", async () => {
    const { warehouse, ctx } = await setup();
    const other = await makeCompany("Other Co");
    const otherCategory = await makeCategory(other.id, "Theirs");

    // A category id that exists but belongs elsewhere must resolve to no
    // products — never to every product, which is what a subtree walk that
    // ignores ownership would produce.
    await expect(createStockCount(ctx, {
      warehouseId: warehouse.id,
      scope: { scopeType: "CATEGORY", categoryId: otherCategory.id },
    })).rejects.toMatchObject({ code: "COUNT_EMPTY_SCOPE" });

    expect(await prisma.stockCountSession.count()).toBe(0);
  });
});

async function openSession(qty = 10) {
  const s = await stocked(qty);
  const created = await createStockCount(s.ctx, {
    warehouseId: s.warehouse.id, scope: { scopeType: "WAREHOUSE" },
  });
  const line = await prisma.stockCountLine.findFirstOrThrow();
  return { ...s, sessionId: created.sessionId, lineId: line.id };
}

describe("recordCount", () => {
  beforeEach(resetDb);

  it("stores the counted quantity, who counted it, and when", async () => {
    const { ctx, lineId } = await openSession();

    await recordCount(ctx, { lineId, countedQty: toQty(8) });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedQty).toBe(toQty(8));
    expect(line.countedAt).not.toBeNull();
  });

  it("clears a pending recount request", async () => {
    const { ctx, lineId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(8) });
    await requestRecount(ctx, { lineId });

    await recordCount(ctx, { lineId, countedQty: toQty(9) });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.recountRequested).toBe(false);
    expect(line.countedQty).toBe(toQty(9));
  });

  it("refuses a negative count", async () => {
    const { ctx, lineId } = await openSession();

    await expect(recordCount(ctx, { lineId, countedQty: -1 }))
      .rejects.toMatchObject({ code: "INVALID_QUANTITY" });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedQty).toBeNull();
  });

  it("refuses a line belonging to another company", async () => {
    const { lineId } = await openSession();
    const other = await makeCompany("Other Co");
    const otherCtx = makeCtx(other.id);

    await expect(recordCount(otherCtx, { lineId, countedQty: toQty(5) }))
      .rejects.toMatchObject({ code: "COUNT_LINE_FOREIGN" });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedQty).toBeNull();
  });

  it("refuses to record against a session that is no longer OPEN", async () => {
    const { ctx, lineId, sessionId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(8) });
    await submitForReview(ctx, { sessionId });

    await expect(recordCount(ctx, { lineId, countedQty: toQty(7) }))
      .rejects.toMatchObject({ code: "COUNT_NOT_COUNTABLE" });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedQty).toBe(toQty(8));
  });
});

describe("requestRecount", () => {
  beforeEach(resetDb);

  it("clears the count and returns a REVIEW session to OPEN", async () => {
    const { ctx, lineId, sessionId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(8) });
    await submitForReview(ctx, { sessionId });

    await requestRecount(ctx, { lineId });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedQty).toBeNull();
    expect(line.recountRequested).toBe(true);
    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("OPEN");
  });

  it("refuses a recount request on a CANCELLED session", async () => {
    const { ctx, lineId, sessionId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(8) });
    await cancelStockCount(ctx, { sessionId, reason: "No longer needed" });

    await expect(requestRecount(ctx, { lineId }))
      .rejects.toMatchObject({ code: "COUNT_NOT_COUNTABLE" });

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedQty).toBe(toQty(8));
    expect(line.recountRequested).toBe(false);
    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("CANCELLED");
  });
});

describe("submitForReview", () => {
  beforeEach(resetDb);

  it("moves an OPEN session to REVIEW and reports coverage", async () => {
    const { ctx, lineId, sessionId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(8) });

    const result = await submitForReview(ctx, { sessionId });

    expect(result.countedLines).toBe(1);
    expect(result.uncountedLines).toBe(0);
    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("REVIEW");
  });

  it("refuses a session with nothing counted at all", async () => {
    const { ctx, sessionId } = await openSession();

    await expect(submitForReview(ctx, { sessionId }))
      .rejects.toMatchObject({ code: "COUNT_NOTHING_COUNTED" });

    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("OPEN");
  });

  it("refuses to submit a session that is already in REVIEW", async () => {
    const { ctx, lineId, sessionId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(8) });
    await submitForReview(ctx, { sessionId });

    await expect(submitForReview(ctx, { sessionId }))
      .rejects.toMatchObject({ code: "COUNT_NOT_COUNTABLE" });

    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("REVIEW");
  });
});

describe("cancelStockCount", () => {
  beforeEach(resetDb);

  it("cancels an open session with a reason and moves no stock", async () => {
    const { ctx, sessionId } = await openSession();

    await cancelStockCount(ctx, { sessionId, reason: "Recounting next week" });

    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("CANCELLED");
    expect(session.cancelledReason).toBe("Recounting next week");
    // Only the opening receipt's movement exists.
    expect(await prisma.inventoryMovement.count()).toBe(1);
  });

  it("requires a reason", async () => {
    const { ctx, sessionId } = await openSession();

    await expect(cancelStockCount(ctx, { sessionId, reason: "  " }))
      .rejects.toMatchObject({ code: "REASON_REQUIRED" });

    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("OPEN");
  });

  it("refuses to cancel a session that is already CANCELLED", async () => {
    const { ctx, sessionId } = await openSession();
    await cancelStockCount(ctx, { sessionId, reason: "First cancellation" });

    await expect(cancelStockCount(ctx, { sessionId, reason: "Second cancellation" }))
      .rejects.toMatchObject({ code: "COUNT_NOT_COUNTABLE" });

    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("CANCELLED");
    expect(session.cancelledReason).toBe("First cancellation");
  });
});

describe("postStockCount", () => {
  beforeEach(resetDb);

  // THE load-bearing test. Variance is measured against the snapshot taken
  // when the line was created, NOT against the live balance at posting time.
  // Set-to-counted semantics (what adjustStock does) would leave 95 here and
  // silently erase the sale of 3 that happened during the count.
  it("preserves stock movements that happen during the count", async () => {
    const { ctx, warehouse, product } = await stocked(100);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();

    // The shop keeps trading: 3 units leave after the snapshot.
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(3), reason: "INTERNAL_USE",
    });

    // The counter finds 95 on the shelf against a snapshot of 100.
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(95) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    await postStockCount(ctx, { sessionId: created.sessionId });

    // 97 live - 5 shortfall = 92. NOT 95.
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(92));

    const posted = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(posted.postedDelta).toBe(toQty(-5));
    expect(posted.liveQtyAtPost).toBe(toQty(97));
  });

  // The single worst failure available in this feature: reading a null
  // countedQty as "counted zero" would write off the entire stock of every
  // product nobody reached.
  it("never treats an uncounted line as zero", async () => {
    const { ctx, warehouse } = await stocked(10);
    const second = await makeProduct(ctx.companyId, { sku: "UNCOUNTED" });
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: second.id,
      quantity: toQty(40), unitCost: toCost(toMinor(5)),
    });
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const countedLine = await prisma.stockCountLine.findFirstOrThrow({
      where: { product: { sku: { not: "UNCOUNTED" } } },
    });

    await recordCount(ctx, { lineId: countedLine.id, countedQty: toQty(9) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    const result = await postStockCount(ctx, { sessionId: created.sessionId });

    expect(result.linesSkipped).toBe(1);
    const untouched = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: second.id },
    });
    expect(untouched.availableQty).toBe(toQty(40));
    const skipped = await prisma.stockCountLine.findFirstOrThrow({
      where: { productId: second.id },
    });
    expect(skipped.postedDelta).toBeNull();
    // A line nobody reached was never posted, so it must never gain a
    // liveQtyAtPost either -- that field is proof-of-posting, not a snapshot.
    expect(skipped.liveQtyAtPost).toBeNull();
  });

  it("records a zero-variance line as verified without creating a movement", async () => {
    const { ctx, warehouse } = await stocked(10);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    const movementsBefore = await prisma.inventoryMovement.count();

    await recordCount(ctx, { lineId: line.id, countedQty: toQty(10) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    const result = await postStockCount(ctx, { sessionId: created.sessionId });

    expect(result.movementsCreated).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    const posted = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(posted.postedDelta).toBe(0);
    // Zero variance still posts: the line is recorded as verified against
    // the live balance at that moment, not left blank.
    expect(posted.liveQtyAtPost).toBe(toQty(10));
  });

  it("tags its movements as STOCK_COUNT so they stay distinct from manual adjustments", async () => {
    const { ctx, warehouse } = await stocked(10);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(7) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    await postStockCount(ctx, { sessionId: created.sessionId });

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: "STOCK_COUNT" },
    });
    expect(movement.movementType).toBe("ADJUSTMENT_OUT");
    expect(movement.referenceNumber).toBe("CNT-0001");
    expect(movement.quantity).toBe(toQty(3));
  });

  it("refuses to post twice and writes nothing on the second attempt", async () => {
    const { ctx, warehouse } = await stocked(10);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(7) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    await postStockCount(ctx, { sessionId: created.sessionId });

    const movementsAfterFirst = await prisma.inventoryMovement.count();
    const balanceAfterFirst = await prisma.inventoryBalance.findFirstOrThrow();

    await expect(postStockCount(ctx, { sessionId: created.sessionId }))
      .rejects.toMatchObject({ code: "COUNT_ALREADY_POSTED" });

    expect(await prisma.inventoryMovement.count()).toBe(movementsAfterFirst);
    const balanceNow = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balanceNow.availableQty).toBe(balanceAfterFirst.availableQty);
  });

  it("refuses to post a session that was never submitted for review", async () => {
    const { ctx, warehouse } = await stocked(10);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(7) });

    await expect(postStockCount(ctx, { sessionId: created.sessionId }))
      .rejects.toMatchObject({ code: "COUNT_NOT_IN_REVIEW" });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(10));
  });

  it("values an increase at the current average cost", async () => {
    const { ctx, warehouse } = await stocked(10); // received at 30
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(12) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    await postStockCount(ctx, { sessionId: created.sessionId });

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: "STOCK_COUNT" },
    });
    expect(movement.movementType).toBe("ADJUSTMENT_IN");
    expect(movement.unitCost).toBe(toCost(toMinor(30)));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.avgCost).toBe(toCost(toMinor(30)));
  });

  it("refuses a session belonging to another company", async () => {
    const { ctx, warehouse } = await stocked(10);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(7) });
    await submitForReview(ctx, { sessionId: created.sessionId });

    const other = await makeCompany("Other Co");
    await expect(postStockCount(makeCtx(other.id), { sessionId: created.sessionId }))
      .rejects.toThrow();

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(10));
  });

  // A CANCELLED session is a dead end, not "not yet submitted" -- the
  // COUNT_NOT_IN_REVIEW message tells the merchant to submit for review
  // first, which is impossible advice for a session that can never move
  // again. It must branch to COUNT_NOT_COUNTABLE instead.
  it("refuses to post a CANCELLED session with COUNT_NOT_COUNTABLE, not COUNT_NOT_IN_REVIEW", async () => {
    const { ctx, warehouse, sessionId, lineId } = await openSession();
    await recordCount(ctx, { lineId, countedQty: toQty(7) });
    await cancelStockCount(ctx, { sessionId, reason: "No longer needed" });

    await expect(postStockCount(ctx, { sessionId }))
      .rejects.toMatchObject({ code: "COUNT_NOT_COUNTABLE" });

    const session = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("CANCELLED");
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: warehouse.id },
    });
    expect(balance.availableQty).toBe(toQty(10));
    // Only the opening receipt's movement exists; posting never ran.
    expect(await prisma.inventoryMovement.count()).toBe(1);
  });

  // The decision made for this finding: keep the transaction all-or-nothing
  // and keep deferring to allowNegativeInventory, but stop a shortfall
  // bigger than the live balance from surfacing as a bare INSUFFICIENT_STOCK
  // that also silently rolls back every other line in the session.
  it("rejects a shortfall bigger than the live balance and writes nothing", async () => {
    const { ctx, warehouse, product } = await stocked(100);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();

    // Concurrent sales drain the live balance to 2 after the snapshot was
    // taken at 100.
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(98), reason: "INTERNAL_USE",
    });

    // The counter finds 95 against a snapshot of 100: delta is -5, but only
    // 2 units are actually on hand to remove.
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(95) });
    await submitForReview(ctx, { sessionId: created.sessionId });

    const movementsBefore = await prisma.inventoryMovement.count();

    await expect(postStockCount(ctx, { sessionId: created.sessionId }))
      .rejects.toMatchObject({
        code: "COUNT_SHORTFALL_EXCEEDS_STOCK",
        details: { productId: product.id, delta: toQty(-5), liveQty: toQty(2) },
      });

    // The whole transaction rolled back: session still REVIEW, balance
    // still at the live 2, no movement, and the line untouched.
    const session = await prisma.stockCountSession.findUniqueOrThrow({
      where: { id: created.sessionId },
    });
    expect(session.status).toBe("REVIEW");
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(2));
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    const untouched = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(untouched.postedDelta).toBeNull();
    expect(untouched.liveQtyAtPost).toBeNull();
  });

  it("allows a shortfall bigger than the live balance when the company allows negative inventory", async () => {
    const { ctx, company, warehouse, product } = await stocked(100);
    await prisma.company.update({
      where: { id: company.id },
      data: { allowNegativeInventory: true },
    });
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(98), reason: "INTERNAL_USE",
    });
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(95) });
    await submitForReview(ctx, { sessionId: created.sessionId });

    await postStockCount(ctx, { sessionId: created.sessionId });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(-3));
  });

  it("posts a variance line for a variant product against its own balance row", async () => {
    const { ctx, warehouse, product } = await setup();
    const variant = await makeProductVariant(ctx.companyId, product.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id, variantId: variant.id,
      quantity: toQty(10), unitCost: toCost(toMinor(20)),
    });

    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    expect(line.variantId).toBe(variant.id);
    expect(line.variantKey).toBe(variant.id);
    expect(line.snapshotQty).toBe(toQty(10));

    await recordCount(ctx, { lineId: line.id, countedQty: toQty(8) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    await postStockCount(ctx, { sessionId: created.sessionId });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { variantId: variant.id },
    });
    expect(balance.availableQty).toBe(toQty(8));
    const posted = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(posted.postedDelta).toBe(toQty(-2));
    expect(posted.liveQtyAtPost).toBe(toQty(10));
  });

  it("applies both a positive and a negative variance within a single post", async () => {
    const { ctx, warehouse, product } = await stocked(10);
    const productB = await makeProduct(ctx.companyId, { sku: "SKU-2" });
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: productB.id,
      quantity: toQty(20), unitCost: toCost(toMinor(15)),
    });

    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const lineA = await prisma.stockCountLine.findFirstOrThrow({
      where: { productId: product.id },
    });
    const lineB = await prisma.stockCountLine.findFirstOrThrow({
      where: { productId: productB.id },
    });

    await recordCount(ctx, { lineId: lineA.id, countedQty: toQty(12) }); // +2
    await recordCount(ctx, { lineId: lineB.id, countedQty: toQty(15) }); // -5
    await submitForReview(ctx, { sessionId: created.sessionId });
    const result = await postStockCount(ctx, { sessionId: created.sessionId });

    expect(result.movementsCreated).toBe(2);
    const balA = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: product.id } });
    const balB = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: productB.id } });
    expect(balA.availableQty).toBe(toQty(12));
    expect(balB.availableQty).toBe(toQty(15));

    const movA = await prisma.inventoryMovement.findFirstOrThrow({
      where: { productId: product.id, referenceType: "STOCK_COUNT" },
    });
    const movB = await prisma.inventoryMovement.findFirstOrThrow({
      where: { productId: productB.id, referenceType: "STOCK_COUNT" },
    });
    expect(movA.movementType).toBe("ADJUSTMENT_IN");
    expect(movA.direction).toBe("IN");
    expect(movB.movementType).toBe("ADJUSTMENT_OUT");
    expect(movB.direction).toBe("OUT");
  });

  it("writes reason as null rather than an English token, letting referenceType carry provenance", async () => {
    const { ctx, warehouse } = await stocked(10);
    const created = await createStockCount(ctx, {
      warehouseId: warehouse.id, scope: { scopeType: "WAREHOUSE" },
    });
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await recordCount(ctx, { lineId: line.id, countedQty: toQty(7) });
    await submitForReview(ctx, { sessionId: created.sessionId });
    await postStockCount(ctx, { sessionId: created.sessionId });

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: "STOCK_COUNT" },
    });
    expect(movement.reason).toBeNull();
  });
});

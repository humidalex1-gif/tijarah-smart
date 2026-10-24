import { prisma, type Tx } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { ServiceError, invalidState } from "@/services/errors";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";
import { collectSubtreeIds } from "@/lib/tree";
import { applyMovement } from "@/services/inventory";

export type CountScope =
  | { scopeType: "WAREHOUSE" }
  | { scopeType: "CATEGORY"; categoryId: string }
  | { scopeType: "BRAND"; brandId: string }
  | { scopeType: "MANUAL"; productIds: string[] };

export async function createStockCount(
  ctx: ServiceContext,
  input: { warehouseId: string; scope: CountScope; notes?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    // Tenant gate on the warehouse before anything else reads from it.
    await tx.warehouse.findFirstOrThrow({
      where: { id: input.warehouseId, companyId: ctx.companyId },
    });

    const scope = input.scope;

    // ProductCategory is a tree (a nullable parentId), so a CATEGORY scope has
    // to cover the whole subtree. Matching categoryId exactly meant a count
    // scoped to "Beverages" silently excluded everything under "Beverages >
    // Soft drinks" — and each excluded product was then reported as "not
    // counted", which reads as the counter having skipped it rather than the
    // scope never having covered it.
    //
    // Resolved in application code: SQLite has no recursive CTE reachable
    // through Prisma's adapter here, and there is no path column. The nodes
    // are loaded tenant-scoped, so a categoryId belonging to another company
    // is simply absent from the set and collectSubtreeIds returns [] —
    // yielding no products rather than every product.
    let categoryIds: string[] = [];
    if (scope.scopeType === "CATEGORY") {
      const categories = await tx.productCategory.findMany({
        where: { companyId: ctx.companyId },
        select: { id: true, parentId: true },
      });
      categoryIds = collectSubtreeIds(categories, scope.categoryId);
    }

    const productWhere = {
      companyId: ctx.companyId,
      status: "ACTIVE",
      trackInventory: true,
      ...(scope.scopeType === "CATEGORY" ? { categoryId: { in: categoryIds } } : {}),
      ...(scope.scopeType === "BRAND" ? { brandId: scope.brandId } : {}),
      ...(scope.scopeType === "MANUAL" ? { id: { in: scope.productIds } } : {}),
    };

    const products = await tx.product.findMany({
      where: productWhere,
      select: { id: true, variants: { select: { id: true } } },
      orderBy: { sku: "asc" },
    });

    // One line per countable UNIT: a variant product is counted per variant,
    // a simple product once. This must match InventoryBalance's grain or the
    // snapshot lookup below silently misses.
    const units: Array<{ productId: string; variantId: string | null }> = [];
    for (const p of products) {
      if (p.variants.length > 0) {
        for (const v of p.variants) units.push({ productId: p.id, variantId: v.id });
      } else {
        units.push({ productId: p.id, variantId: null });
      }
    }

    if (units.length === 0) {
      throw invalidState("COUNT_EMPTY_SCOPE", { scopeType: scope.scopeType });
    }

    // Read every relevant balance in one query rather than per unit.
    const balances = await tx.inventoryBalance.findMany({
      where: {
        companyId: ctx.companyId,
        warehouseId: input.warehouseId,
        productId: { in: products.map((p) => p.id) },
      },
      select: { productId: true, variantKey: true, availableQty: true },
    });
    const snapshotFor = new Map(
      balances.map((b) => [`${b.productId}:${b.variantKey}`, b.availableQty]),
    );

    const countNumber = await nextNumber(tx, ctx.companyId, "CNT");
    const session = await tx.stockCountSession.create({
      data: {
        companyId: ctx.companyId,
        warehouseId: input.warehouseId,
        countNumber,
        status: "OPEN",
        scopeType: scope.scopeType,
        scopeCategoryId: scope.scopeType === "CATEGORY" ? scope.categoryId : null,
        scopeBrandId: scope.scopeType === "BRAND" ? scope.brandId : null,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId,
      },
    });

    await tx.stockCountLine.createMany({
      data: units.map((u) => {
        const variantKey = u.variantId ?? "";
        return {
          companyId: ctx.companyId,
          sessionId: session.id,
          productId: u.productId,
          variantId: u.variantId,
          variantKey,
          // A missing balance row means the system believes there is none of
          // this here. That is a countable claim, not a reason to skip.
          snapshotQty: snapshotFor.get(`${u.productId}:${variantKey}`) ?? 0,
        };
      }),
    });

    await writeAudit(tx, ctx, {
      action: "STOCK_COUNT_CREATED",
      entityType: "StockCountSession",
      entityId: session.id,
      newValues: { countNumber, scopeType: scope.scopeType, lineCount: units.length },
    });

    return { sessionId: session.id, countNumber, lineCount: units.length };
  });
}

/**
 * Loads a line and its session with the tenant check on BOTH. The line
 * carries its own companyId, but a line could in principle be attached to a
 * session belonging elsewhere, so the session is re-checked rather than
 * trusted through the relation.
 */
async function loadLine(tx: Tx, ctx: ServiceContext, lineId: string) {
  const line = await tx.stockCountLine.findFirst({
    where: { id: lineId, companyId: ctx.companyId },
    include: { session: true },
  });
  if (!line || line.session.companyId !== ctx.companyId) {
    throw invalidState("COUNT_LINE_FOREIGN", { lineId });
  }
  return line;
}

export async function recordCount(
  ctx: ServiceContext,
  input: { lineId: string; countedQty: number },
) {
  if (!Number.isInteger(input.countedQty) || input.countedQty < 0) {
    throw invalidState("INVALID_QUANTITY", { countedQty: input.countedQty });
  }

  return prisma.$transaction(async (tx) => {
    const line = await loadLine(tx, ctx, input.lineId);
    if (line.session.status !== "OPEN") {
      throw invalidState("COUNT_NOT_COUNTABLE", { status: line.session.status });
    }

    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        countedQty: input.countedQty,
        countedAt: new Date(),
        countedByUserId: ctx.userId,
        recountRequested: false,
      },
    });

    return { lineId: line.id };
  });
}

export async function requestRecount(ctx: ServiceContext, input: { lineId: string }) {
  return prisma.$transaction(async (tx) => {
    const line = await loadLine(tx, ctx, input.lineId);
    if (line.session.status === "POSTED" || line.session.status === "CANCELLED") {
      throw invalidState("COUNT_NOT_COUNTABLE", { status: line.session.status });
    }

    await tx.stockCountLine.update({
      where: { id: line.id },
      data: { countedQty: null, countedAt: null, countedByUserId: null, recountRequested: true },
    });

    // A recount means the session is no longer ready to post. Sending it
    // back to OPEN is what lets the counter reach the line again — the
    // counting screen only serves OPEN sessions.
    if (line.session.status === "REVIEW") {
      await tx.stockCountSession.update({
        where: { id: line.sessionId },
        data: { status: "OPEN" },
      });
    }

    return { lineId: line.id };
  });
}

export async function submitForReview(ctx: ServiceContext, input: { sessionId: string }) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.stockCountSession.findFirst({
      where: { id: input.sessionId, companyId: ctx.companyId },
      include: { lines: { select: { countedQty: true } } },
    });
    if (!session) throw invalidState("COUNT_LINE_FOREIGN", { sessionId: input.sessionId });
    if (session.status !== "OPEN") {
      throw invalidState("COUNT_NOT_COUNTABLE", { status: session.status });
    }

    const countedLines = session.lines.filter((l) => l.countedQty !== null).length;
    const uncountedLines = session.lines.length - countedLines;
    // A session where nothing was counted has no finding to review. Posting
    // it would be a no-op that still reads as "we verified this stock".
    if (countedLines === 0) throw invalidState("COUNT_NOTHING_COUNTED", {});

    await tx.stockCountSession.update({
      where: { id: session.id },
      data: { status: "REVIEW" },
    });

    return { sessionId: session.id, countedLines, uncountedLines };
  });
}

export async function cancelStockCount(
  ctx: ServiceContext,
  input: { sessionId: string; reason: string },
) {
  if (!input.reason || input.reason.trim() === "") {
    throw invalidState("REASON_REQUIRED", {});
  }

  return prisma.$transaction(async (tx) => {
    const session = await tx.stockCountSession.findFirst({
      where: { id: input.sessionId, companyId: ctx.companyId },
    });
    if (!session) throw invalidState("COUNT_LINE_FOREIGN", { sessionId: input.sessionId });
    if (session.status === "POSTED" || session.status === "CANCELLED") {
      throw invalidState("COUNT_NOT_COUNTABLE", { status: session.status });
    }

    await tx.stockCountSession.update({
      where: { id: session.id },
      data: { status: "CANCELLED", cancelledReason: input.reason.trim() },
    });

    await writeAudit(tx, ctx, {
      action: "STOCK_COUNT_CANCELLED",
      entityType: "StockCountSession",
      entityId: session.id,
      oldValues: { status: session.status },
      newValues: { status: "CANCELLED", reason: input.reason.trim() },
    });

    return { sessionId: session.id };
  });
}

export async function postStockCount(ctx: ServiceContext, input: { sessionId: string }) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.stockCountSession.findFirst({
      where: { id: input.sessionId, companyId: ctx.companyId },
      include: { lines: true },
    });
    if (!session) throw invalidState("COUNT_LINE_FOREIGN", { sessionId: input.sessionId });

    // In-transaction backstop, not merely a UI guard: a server action is an
    // independently addressable endpoint, and a double-submit would
    // otherwise apply every delta twice.
    if (session.status === "POSTED") throw invalidState("COUNT_ALREADY_POSTED", {});
    // CANCELLED is a dead end, not "not yet submitted" — COUNT_NOT_IN_REVIEW's
    // message tells the merchant to submit for review first, which is
    // impossible advice for a session that can never be revived.
    if (session.status === "CANCELLED") {
      throw invalidState("COUNT_NOT_COUNTABLE", { status: session.status });
    }
    if (session.status !== "REVIEW") {
      throw invalidState("COUNT_NOT_IN_REVIEW", { status: session.status });
    }

    // One bulk read for every balance this session can touch, up front. This
    // does NOT eliminate the per-line getBalance() cost — applyMovement
    // below still calls getBalance() itself for every line with a NONZERO
    // delta, re-running the same ownership checks and a second balance read.
    // What this saves is the read (and those checks) for every line whose
    // count matches its snapshot, which never reaches applyMovement at all.
    // A whole-warehouse count can run to thousands of lines and is mostly
    // zero-variance in the common case, so that was enough to stop blowing
    // past the interactive-transaction timeout — but a reconciliation where
    // most lines carry real variance still approaches the old per-line cost.
    const balances = await tx.inventoryBalance.findMany({
      where: {
        companyId: ctx.companyId,
        warehouseId: session.warehouseId,
        productId: { in: session.lines.map((l) => l.productId) },
      },
      select: { productId: true, variantKey: true, availableQty: true, avgCost: true },
    });
    const balanceFor = new Map(balances.map((b) => [`${b.productId}:${b.variantKey}`, b]));

    let linesPosted = 0;
    let linesSkipped = 0;
    let movementsCreated = 0;

    for (const line of session.lines) {
      // null means nobody counted this line. It does NOT mean zero — reading
      // it as zero would write off the whole stock of everything the counter
      // did not reach.
      if (line.countedQty === null) {
        linesSkipped += 1;
        continue;
      }

      // A missing map entry means no balance row exists yet — same default
      // getBalance() used, but without getBalance()'s side effect of
      // materialising an empty row for a line that turns out to have zero
      // variance.
      const balance = balanceFor.get(`${line.productId}:${line.variantKey}`)
        ?? { availableQty: 0, avgCost: 0 };
      // Variance is measured against the snapshot taken when the line was
      // created, NEVER against the live balance read just above. The shop
      // keeps trading during a count; the live balance already reflects
      // every sale/receipt since the snapshot, and the counted figure only
      // tells us what is missing or extra relative to the snapshot moment.
      const delta = line.countedQty - line.snapshotQty;

      if (delta !== 0) {
        try {
          await applyMovement(tx, ctx, {
            warehouseId: session.warehouseId,
            productId: line.productId,
            variantId: line.variantId,
            movementType: delta > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
            direction: delta > 0 ? "IN" : "OUT",
            quantity: Math.abs(delta),
            // An increase with no known cost is valued at the current average,
            // matching adjustStock.
            unitCost: balance.avgCost,
            // Distinct from STOCK_ADJUSTMENT so a count-driven correction stays
            // tellable from a hand-typed one in movement history forever. This
            // is why this is a new service rather than a mode on adjustStock.
            referenceType: "STOCK_COUNT",
            referenceId: session.id,
            referenceNumber: session.countNumber,
            // reason is free text rendered verbatim to merchants elsewhere;
            // referenceType above already carries this movement's provenance,
            // so there is nothing human to say here.
            reason: null,
          });
        } catch (err) {
          // A shortfall bigger than the live balance happens whenever the
          // shop keeps trading during the count (or allowNegativeInventory
          // is off) — surface it as a count-specific error naming the line,
          // instead of a bare INSUFFICIENT_STOCK that gives no hint this
          // came from a count and rolls back every other line in the batch
          // right along with it. Any other failure is not ours to reinterpret.
          if (err instanceof ServiceError && err.code === "INSUFFICIENT_STOCK") {
            throw new ServiceError("COUNT_SHORTFALL_EXCEEDS_STOCK", {
              productId: line.productId,
              delta,
              liveQty: balance.availableQty,
            });
          }
          throw err;
        }
        movementsCreated += 1;
      }

      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { postedDelta: delta, liveQtyAtPost: balance.availableQty },
      });
      linesPosted += 1;
    }

    await tx.stockCountSession.update({
      where: { id: session.id },
      data: { status: "POSTED", postedByUserId: ctx.userId, postedAt: new Date() },
    });

    await writeAudit(tx, ctx, {
      action: "STOCK_COUNT_POSTED",
      entityType: "StockCountSession",
      entityId: session.id,
      oldValues: { status: "REVIEW" },
      newValues: { status: "POSTED", linesPosted, linesSkipped, movementsCreated },
    });

    return { sessionId: session.id, linesPosted, linesSkipped, movementsCreated };
  });
}

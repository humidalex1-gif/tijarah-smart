import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual, issueStock } from "@/services/stock";
import { openClaim, openClaims } from "@/services/claims";
import { previewReconcile, postReconcile } from "@/services/reconcile";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../tests/factories";

/**
 * The design spec's worked example, up to the point of reconciliation:
 * 100 shipped to the warehouse, 60 gone out, so 40 on the shelf, and 10 units
 * Salla says came back that the warehouse has never confirmed.
 *
 * Expected on hand is therefore 50: 40 shelf + 10 disputed.
 */
async function scenario() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id);

  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(100), unitCost: toCost(toMinor(10)),
  });
  await issueStock(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(60), reason: "INTERNAL_USE",
  });
  await openClaim(ctx, {
    productId: product.id, kind: "RETURN", assertedBy: "SALLA",
    quantity: toQty(10), warehouseId: warehouse.id,
  });

  return { company, warehouse, ctx, product };
}

const asOf = new Date("2026-07-31T00:00:00.000Z");

describe("damaged returns", () => {
  beforeEach(resetDb);

  /**
   * The owner's ruling of 2026-08-05. The warehouse says the shelf is exactly
   * what the books say — 40 — and separately reports 10 damaged that the books
   * and the open DAMAGE claims do not explain. There are 10 units in dispute:
   * returns Salla says came back.
   *
   * Those 10 damaged units cannot have come off a shelf that is not short.
   * They are the returns, and they came back broken. Writing off intact shelf
   * stock instead destroys 10 good units on paper and leaves the return claim
   * open to age forever.
   */
  it("settles disputed returns as damaged instead of writing off intact shelf stock", async () => {
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(40), damaged: toQty(10) }],
    });

    expect(line.damagedDelta).toBe(toQty(10));
    expect(line.damagedReturns).toBe(toQty(10));
    expect(line.unexplained).toBe(0);
    expect(line.stillClaimed).toBe(0);

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: false,
      lines: [{ productId: product.id, sellable: toQty(40), damaged: toQty(10) }],
    });
    expect(result.settledClaims).toBe(toQty(10));

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    // The shelf is untouched: the warehouse just said it holds 40.
    expect(balance.availableQty).toBe(toQty(40));
    expect(balance.damagedQty).toBe(toQty(10));
    expect(balance.disputedQty).toBe(0);

    const claims = await openClaims(ctx, {});
    expect(claims).toHaveLength(0);
  });

  it("still writes damage off the shelf when the shelf is genuinely short", async () => {
    // The other half. 40 on the shelf, warehouse says 34 sellable and 6
    // damaged: those six ARE shelf units that broke, and the return claim has
    // nothing to do with it. Attributing them to the return instead would
    // close a claim the warehouse never confirmed and hide a real shelf loss.
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(34), damaged: toQty(6) }],
    });

    expect(line.damagedDelta).toBe(toQty(6));
    expect(line.damagedReturns).toBe(0);
    expect(line.unexplained).toBe(0);
    expect(line.stillClaimed).toBe(toQty(10));

    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: false,
      lines: [{ productId: product.id, sellable: toQty(34), damaged: toQty(6) }],
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(balance.availableQty).toBe(toQty(34));
    expect(balance.damagedQty).toBe(toQty(6));
    // The return is still outstanding — nobody confirmed it.
    expect(balance.disputedQty).toBe(toQty(10));
  });
});

describe("previewReconcile", () => {
  beforeEach(resetDb);

  it("decomposes the gap into open claims and unexplained shrinkage", async () => {
    // The spec's headline case. Warehouse asserts 37 against an expected 50.
    // The product must say WHERE the 13 went, not merely that it is 13.
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    expect(line.expectedSellable).toBe(toQty(50));
    expect(line.gap).toBe(toQty(13));
    expect(line.stillClaimed).toBe(toQty(10));
    expect(line.unexplained).toBe(toQty(3));
    expect(line.settleableSellable).toBe(0);
    expect(line.determinate).toBe(true);
  });

  it("settles every claim when the warehouse confirms the full expected quantity", async () => {
    // The case the first draft of this arithmetic got wrong. Asserting 50
    // means all 10 returns arrived AND the shelf is intact, so the gap is zero
    // — but the claims must still CLOSE. A decomposition keyed off the gap
    // would settle nothing and leave them ageing forever.
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(50) }],
    });

    expect(line.gap).toBe(0);
    expect(line.settleableSellable).toBe(toQty(10));
    expect(line.stillClaimed).toBe(0);
    expect(line.unexplained).toBe(0);
  });

  it("splits a partial confirmation between settled and still claimed", async () => {
    // 45 asserted: the 40 shelf units are all there and 5 of the 10 returns
    // arrived. Nothing is unexplained — 5 are simply still outstanding.
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(45) }],
    });

    expect(line.settleableSellable).toBe(toQty(5));
    expect(line.stillClaimed).toBe(toQty(5));
    expect(line.unexplained).toBe(0);
    expect(line.gap).toBe(toQty(5));
  });

  it("reports a surplus without inventing shrinkage", async () => {
    // More than expected is a real finding, not an error, and it must never
    // be reported as a negative loss.
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(55) }],
    });

    expect(line.surplus).toBe(toQty(5));
    expect(line.unexplained).toBe(0);
    expect(line.settleableSellable).toBe(toQty(10));
    expect(line.gap).toBe(toQty(-5));
  });

  it("marks a line indeterminate when one aggregate figure meets two kinds of claim", async () => {
    // Spec 3.2. With returns AND damage outstanding, a single combined number
    // cannot distinguish "3 returns landed" from "13 landed and 10 vanished".
    // No arithmetic resolves it, so the system must not pretend.
    const { ctx, warehouse, product } = await scenario();
    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(4), warehouseId: warehouse.id,
    });

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    expect(line.determinate).toBe(false);
  });

  it("is determinate when sellable and damaged arrive as two figures", async () => {
    const { ctx, warehouse, product } = await scenario();
    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(4), warehouseId: warehouse.id,
    });

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(33), damaged: toQty(4) }],
    });

    expect(line.determinate).toBe(true);
  });

  it("stays determinate with a single figure when only one kind of claim is open", async () => {
    const { ctx, warehouse, product } = await scenario();

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    expect(line.determinate).toBe(true);
  });

  it("does not read another company's balances", async () => {
    const { warehouse, product } = await scenario();
    const other = await makeCompany("Other Co");

    await expect(previewReconcile(makeCtx(other.id), {
      warehouseId: warehouse.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    })).rejects.toThrow();
  });
});

describe("postReconcile", () => {
  beforeEach(resetDb);

  it("settles claims first, then posts only the remainder as shrinkage", async () => {
    const { ctx, warehouse, product } = await scenario();

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    expect(result.skipped).toBe(0);
    expect(result.shrinkagePosted).toBe(toQty(3));

    // The claim is untouched: none of it was confirmed.
    const open = await openClaims(ctx, {});
    expect(open).toHaveLength(1);
    expect(open[0].openQty).toBe(toQty(10));

    // The shelf shortage came out of available, leaving 37 sellable.
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(37));
    expect(balance.disputedQty).toBe(toQty(10));
  });

  it("closes the claim and posts nothing when the warehouse confirms everything", async () => {
    const { ctx, warehouse, product } = await scenario();

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(50) }],
    });

    expect(result.settledClaims).toBe(toQty(10));
    expect(result.shrinkagePosted).toBe(0);
    expect(await openClaims(ctx, {})).toHaveLength(0);

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(50));
    expect(balance.disputedQty).toBe(0);
  });

  it("posts nothing at all when the assertion matches expectation with no claims", async () => {
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(20), unitCost: toCost(toMinor(10)),
    });
    const movementsBefore = await prisma.inventoryMovement.count();

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(20) }],
    });

    expect(result.shrinkagePosted).toBe(0);
    expect(result.settledClaims).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
  });

  it("refuses to post an indeterminate line and writes nothing for it", async () => {
    const { ctx, warehouse, product } = await scenario();
    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(4), warehouseId: warehouse.id,
    });
    const movementsBefore = await prisma.inventoryMovement.count();

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    expect(result.skipped).toBe(1);
    expect(result.shrinkagePosted).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect(await openClaims(ctx, {})).toHaveLength(2);
  });

  it("posts per line, so one refused line does not abandon the others", async () => {
    // postStockCount's own comment warns that a whole-catalogue run in one
    // transaction approaches Prisma's interactive timeout. Per-line commit
    // also means a single bad line cannot discard everyone else's work.
    const { ctx, warehouse, product } = await scenario();
    const clean = await makeProduct(ctx.companyId, "SKU-2");
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: clean.id,
      quantity: toQty(20), unitCost: toCost(toMinor(5)),
    });
    // Make the first product indeterminate so its line is refused.
    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(4), warehouseId: warehouse.id,
    });

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [
        { productId: product.id, sellable: toQty(37) },
        { productId: clean.id, sellable: toQty(18) },
      ],
    });

    expect(result.skipped).toBe(1);
    expect(result.shrinkagePosted).toBe(toQty(2));

    const cleanBalance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: clean.id },
    });
    expect(cleanBalance.availableQty).toBe(toQty(18));
  });

  it("keeps another warehouse's claims out of the decomposition entirely", async () => {
    // A RETURN opened at warehouse B belongs to B's shelf. Counting it at A
    // inflated A's expected on-hand by units that were never coming there,
    // and settling it posted against A's balance where nothing was disputed.
    const company = await makeCompany();
    const warehouseA = await makeWarehouse(company.id);
    const warehouseB = await makeWarehouse(company.id, "B");
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouseA.id, productId: product.id,
      quantity: toQty(40), unitCost: toCost(toMinor(10)),
    });
    await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouseB.id,
    });

    const [line] = await previewReconcile(ctx, {
      warehouseId: warehouseA.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(40) }],
    });

    expect(line.expectedSellable).toBe(toQty(40));
    expect(line.gap).toBe(0);
    expect(line.stillClaimed).toBe(0);

    // B still sees its own claim.
    const [lineB] = await previewReconcile(ctx, {
      warehouseId: warehouseB.id, asOf,
      lines: [{ productId: product.id, sellable: toQty(0) }],
    });
    expect(lineB.expectedSellable).toBe(toQty(10));
  });

  it("reports a line that throws as failed, not skipped, and commits none of it", async () => {
    // A LEGACY claim (opened before warehouseId existed, null) is treated as
    // belonging to the queried warehouse — settling it can then hit a balance
    // with nothing disputed and throw. That throw must land in `failed` — a
    // real error the merchant should hear about — never in `skipped`, which
    // is the arithmetic's own deliberate refusal. The line must also leave
    // nothing half-committed.
    const company = await makeCompany();
    const warehouseA = await makeWarehouse(company.id);
    const warehouseB = await makeWarehouse(company.id, "B");
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouseA.id, productId: product.id,
      quantity: toQty(40), unitCost: toCost(toMinor(10)),
    });
    // Open at B (its disputed units live on B's balance), then null the
    // warehouse column to simulate a pre-push legacy row.
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouseB.id,
    });
    await prisma.stockClaim.update({ where: { id: claimId }, data: { warehouseId: null } });

    const result = await postReconcile(ctx, {
      warehouseId: warehouseA.id, asOf, isPhysicalCount: true,
      // 45 sellable against 40 on A's shelf: 5 look settleable, but the
      // disputed units live on B's balance, so the settlement throws.
      lines: [{ productId: product.id, sellable: toQty(45) }],
    });

    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.settledClaims).toBe(0);

    // Atomic per line: the claim is untouched and A's balance unchanged.
    const open = await openClaims(ctx, {});
    expect(open).toHaveLength(1);
    expect(open[0].openQty).toBe(toQty(10));
    const balanceA = await prisma.inventoryBalance.findFirstOrThrow({
      where: { warehouseId: warehouseA.id },
    });
    expect(balanceA.availableQty).toBe(toQty(40));
    expect(balanceA.disputedQty).toBe(0);
  });

  it("books confirmed damage as damaged stock, never as sellable", async () => {
    // Settling every claim kind back into AVAILABLE meant the warehouse
    // CONFIRMING three units damaged made them sellable again at full cost, so
    // inventory value ROSE on the confirmation of a loss.
    const { ctx, warehouse, product } = await scenario();
    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(4), warehouseId: warehouse.id,
    });
    // Available is now 36 (40 less the 4 moved into dispute), disputed 14.

    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(36), damaged: toQty(4) }],
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.damagedQty).toBe(toQty(4));
    // The four confirmed-damaged units must NOT be back in sellable stock.
    expect(balance.availableQty).toBe(toQty(36));
  });

  it("posts an asserted damaged figure that the books do not carry", async () => {
    // Books say 40 sellable, nothing damaged. The warehouse reports 35
    // sellable and 5 damaged. Summing them to 40 made the arithmetic conclude
    // nothing was wrong, so availableQty stayed 40 when only 35 were sellable
    // and the 5 damaged units were recorded nowhere.
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(40), unitCost: toCost(toMinor(10)),
    });

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(35), damaged: toQty(5) }],
    });

    expect(result.damagedPosted).toBe(toQty(5));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(35));
    expect(balance.damagedQty).toBe(toQty(5));
  });

  it("treats an absent damaged figure as unreported, not as zero", async () => {
    // A null means "they did not say". Reading it as zero would post a
    // reclassification reversing damage the books already carry.
    const company = await makeCompany();
    const warehouse = await makeWarehouse(company.id);
    const ctx = makeCtx(company.id);
    const product = await makeProduct(company.id);
    await receiveStockManual(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(40), unitCost: toCost(toMinor(10)),
    });
    await issueStock(ctx, {
      warehouseId: warehouse.id, productId: product.id,
      quantity: toQty(5), reason: "DAMAGED",
    });

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(35) }],
    });

    expect(result.damagedPosted).toBe(0);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.damagedQty).toBe(toQty(5));
  });

  it("dates the shrinkage movement asOf, not today", async () => {
    // A June shelf reconciled in July must land its loss in June, or the
    // profit report attributes it to the wrong month.
    const { ctx, warehouse, product } = await scenario();
    const june = new Date("2026-06-15T00:00:00.000Z");

    await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf: june, isPhysicalCount: true,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: "RECONCILIATION" },
    });
    expect(movement.movementDate.toISOString()).toBe(june.toISOString());
  });

  it("refuses a duplicate product line rather than double-posting the loss", async () => {
    // Both lines carry the full unexplained quantity computed from the same
    // snapshot, so both would post and the loss would be counted twice. The UI
    // cannot produce this but the action accepts an arbitrary JSON array.
    const { ctx, warehouse, product } = await scenario();

    await expect(postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true,
      lines: [
        { productId: product.id, sellable: toQty(37) },
        { productId: product.id, sellable: toQty(37) },
      ],
    })).rejects.toMatchObject({ code: "RECONCILE_DUPLICATE_LINE" });

    expect(await prisma.inventoryMovement.count({
      where: { referenceType: "RECONCILIATION" },
    })).toBe(0);
  });

  it("refuses an empty line list", async () => {
    const { ctx, warehouse } = await scenario();

    await expect(postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: true, lines: [],
    })).rejects.toMatchObject({ code: "RECONCILE_NO_LINES" });
  });

  it("records whether the figures came from a physical count", async () => {
    // Spec 7: a read from the warehouse's own system explains far less than a
    // physical count, and shrinkage derived from it may be their bookkeeping
    // error rather than the merchant's real loss. The flag has to survive to
    // the profit screen, so it is captured here.
    const { ctx, warehouse, product } = await scenario();

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id, asOf, isPhysicalCount: false,
      lines: [{ productId: product.id, sellable: toQty(37) }],
    });

    expect(result.isPhysicalCount).toBe(false);
    expect(result.shrinkagePosted).toBe(toQty(3));
  });
});

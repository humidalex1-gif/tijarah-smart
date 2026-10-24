import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A line of a reconciliation settles claims and then posts that line's
 * shrinkage. This file forces a failure BETWEEN those two steps and asserts
 * nothing survives it.
 *
 * The failure is injected through `nextNumber`, which both halves call with
 * different prefixes: "CLM" for a claim settlement, "RCN" for the shrinkage
 * movement. Refusing only "RCN" lets the settlements land and then kills the
 * line, which is precisely the shape of the defect.
 */
let failOnReconcileNumber = false;

vi.mock("@/services/numbering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/numbering")>();
  return {
    ...actual,
    nextNumber: async (tx: Parameters<typeof actual.nextNumber>[0], companyId: string, prefix: string) => {
      if (failOnReconcileNumber && prefix === "RCN") {
        throw new Error("injected failure after the claims were settled");
      }
      return actual.nextNumber(tx, companyId, prefix);
    },
  };
});

const { prisma } = await import("@/lib/db");
const { toQty, toCost, toMinor } = await import("@/lib/money");
const { receiveStockManual, issueStock } = await import("@/services/stock");
const { openClaim } = await import("@/services/claims");
const { postReconcile } = await import("@/services/reconcile");
const { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } =
  await import("../../tests/factories");

/**
 * A line that does BOTH halves, which the test needs and which takes some
 * arranging: on the sellable side, settling means the warehouse reported MORE
 * than the shelf and shrinkage means it reported LESS, so the two can never
 * co-occur there. A DAMAGE claim settles off the damaged figure instead, which
 * is independent of the sellable one.
 *
 * 100 received, then a 10-unit damage claim moves 10 out of available:
 * available 90, disputed 10, damaged 0.
 *
 * Asserting sellable 85 leaves 5 unexplained, and asserting damaged 10 settles
 * the whole claim. So the line settles AND posts shrinkage.
 */
async function lineThatSettlesAndPostsShrinkage() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id);

  await receiveStockManual(ctx, {
    warehouseId: warehouse.id, productId: product.id,
    quantity: toQty(100), unitCost: toCost(toMinor(10)),
  });
  const { claimId } = await openClaim(ctx, {
    productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
    quantity: toQty(10), warehouseId: warehouse.id,
  });

  return { ctx, warehouse, product, claimId };
}

const ASSERTION = { sellable: toQty(85), damaged: toQty(10) };

describe("postReconcile line atomicity", () => {
  beforeEach(async () => {
    failOnReconcileNumber = false;
    await resetDb();
  });

  it("settles and posts shrinkage together when nothing fails", async () => {
    const { ctx, warehouse, product, claimId } = await lineThatSettlesAndPostsShrinkage();

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id,
      asOf: new Date("2026-02-01T00:00:00.000Z"),
      isPhysicalCount: true,
      lines: [{ productId: product.id, ...ASSERTION }],
    });

    expect(result.settledClaims).toBeGreaterThan(0);
    expect(result.shrinkagePosted).toBeGreaterThan(0);
    const claim = await prisma.stockClaim.findFirstOrThrow({ where: { id: claimId } });
    expect(claim.settledQty).toBeGreaterThan(0);
  });

  it("leaves no settled claim behind when the shrinkage step fails", async () => {
    const { ctx, warehouse, product, claimId } = await lineThatSettlesAndPostsShrinkage();
    const before = await prisma.inventoryBalance.findFirstOrThrow();

    failOnReconcileNumber = true;

    const result = await postReconcile(ctx, {
      warehouseId: warehouse.id,
      asOf: new Date("2026-02-01T00:00:00.000Z"),
      isPhysicalCount: true,
      lines: [{ productId: product.id, ...ASSERTION }],
    });

    // Previously the settlements committed in their own transactions and the
    // counter had already been incremented, so a failed line still reported
    // settled units that no longer existed.
    expect(result.settledClaims).toBe(0);
    expect(result.shrinkagePosted).toBe(0);

    const claim = await prisma.stockClaim.findFirstOrThrow({ where: { id: claimId } });
    expect(claim.settledQty).toBe(0);
    expect(
      await prisma.stockClaimEvent.count({ where: { claimId, eventType: "SETTLED" } }),
    ).toBe(0);

    const after = await prisma.inventoryBalance.findFirstOrThrow();
    expect(after.availableQty).toBe(before.availableQty);
    expect(after.disputedQty).toBe(before.disputedQty);
  });
});

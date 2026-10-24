import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor } from "@/lib/money";
import { receiveStockManual, issueStock } from "@/services/stock";
import { openClaim, settleClaim, settleClaimIn, openClaims, cancelClaim } from "@/services/claims";
import { makeCompany, makeWarehouse, makeProduct, makeCtx, resetDb } from "../../tests/factories";

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const ctx = makeCtx(company.id);
  const product = await makeProduct(company.id);
  await receiveStockManual(ctx, {
    warehouseId: warehouse.id,
    productId: product.id,
    quantity: toQty(100),
    unitCost: toCost(toMinor(10)),
  });
  return { company, warehouse, ctx, product };
}

/**
 * The design spec's worked example, up to the point of reconciliation:
 * 100 shipped to the warehouse, 60 gone out, so 40 sit on the shelf.
 */
async function soldSetup() {
  const base = await setup();
  await issueStock(base.ctx, {
    warehouseId: base.warehouse.id,
    productId: base.product.id,
    quantity: toQty(60),
    reason: "INTERNAL_USE",
  });
  return base;
}

describe("openClaim", () => {
  beforeEach(resetDb);

  it("writes an OPENED event and derives the rollup from it", async () => {
    const { ctx, product, warehouse } = await setup();

    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    const claim = await prisma.stockClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.quantity).toBe(toQty(10));
    expect(claim.settledQty).toBe(0);
    expect(claim.settledAt).toBeNull();
    // The claim remembers WHICH warehouse's balance it disputes. Without
    // this, a claim opened at warehouse B was counted — and settled —
    // against warehouse A's balance at reconcile time.
    expect(claim.warehouseId).toBe(warehouse.id);

    const events = await prisma.stockClaimEvent.findMany({ where: { claimId } });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("OPENED");
    expect(events[0].quantity).toBe(toQty(10));
    expect(events[0].assertedBy).toBe("SALLA");
  });

  it("adds a RETURN to disputed without taking it from available", async () => {
    // THE load-bearing case. Returned units left availableQty when they were
    // sold; they are coming BACK from the customer, so they enter the disputed
    // bucket and nothing leaves. Expected on-hand (available + disputed) must
    // RISE by the returned quantity.
    //
    // The design spec's worked example depends on exactly this: 100 shipped,
    // 60 sold, 50 delivered leaves 40 available, and expected on-hand is 50.
    // Taking the return out of available instead would report 30 + 10 = 40 and
    // understate the shelf by the very quantity the merchant is chasing.
    const { ctx, product, warehouse } = await soldSetup();
    const before = await prisma.inventoryBalance.findFirstOrThrow();
    expect(before.availableQty).toBe(toQty(40));

    await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    const after = await prisma.inventoryBalance.findFirstOrThrow();
    expect(after.availableQty).toBe(toQty(40));
    expect(after.disputedQty).toBe(toQty(10));
    expect(after.availableQty + after.disputedQty).toBe(toQty(50));
    expect(after.avgCost).toBe(before.avgCost);
  });

  it("takes a DAMAGE claim out of available, leaving expected on-hand unchanged", async () => {
    // The opposite direction. These units are already counted on the shelf and
    // their condition is what is in question, so they move across rather than
    // being added. avgCost must not move either way — a disputed unit was
    // bought and averaged when it arrived, and averaging it again would count
    // the same cost twice.
    const { ctx, product, warehouse } = await setup();
    const before = await prisma.inventoryBalance.findFirstOrThrow();

    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(3), warehouseId: warehouse.id,
    });

    const after = await prisma.inventoryBalance.findFirstOrThrow();
    expect(after.availableQty).toBe(toQty(97));
    expect(after.disputedQty).toBe(toQty(3));
    expect(after.availableQty + after.disputedQty).toBe(toQty(100));
    expect(after.avgCost).toBe(before.avgCost);
  });

  it("refuses a claim for another company's product", async () => {
    const { ctx, warehouse } = await setup();
    const other = await makeCompany("Other Co");
    const theirProduct = await makeProduct(other.id, "THEIR-SKU");

    await expect(openClaim(ctx, {
      productId: theirProduct.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(5), warehouseId: warehouse.id,
    })).rejects.toThrow();

    expect(await prisma.stockClaim.count()).toBe(0);
  });

  it("refuses a non-positive quantity", async () => {
    const { ctx, product, warehouse } = await setup();

    await expect(openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: 0, warehouseId: warehouse.id,
    })).rejects.toMatchObject({ code: "CLAIM_INVALID_QUANTITY" });

    expect(await prisma.stockClaimEvent.count()).toBe(0);
  });

  it("is idempotent on the same source reference", async () => {
    // Re-running a sync must not double-claim. sourceKey is a non-null mirror,
    // because a nullable column inside @@unique constrains nothing on SQLite.
    const { ctx, product, warehouse } = await setup();
    const input = {
      productId: product.id, kind: "RETURN" as const, assertedBy: "SALLA" as const,
      quantity: toQty(10), warehouseId: warehouse.id, sourceKey: "shipment-42",
    };

    const first = await openClaim(ctx, input);
    const second = await openClaim(ctx, input);

    expect(second.claimId).toBe(first.claimId);
    expect(await prisma.stockClaim.count()).toBe(1);
    expect(await prisma.stockClaimEvent.count()).toBe(1);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.disputedQty).toBe(toQty(10));
  });

  it("keeps two manual claims for the same product separate", async () => {
    // Three units damaged on Monday and five more on Friday are two different
    // events. An earlier version keyed both on sourceKey "", so the compound
    // unique matched and the second call returned the first's id having
    // written no event, no movement and no quantity — and reported success.
    // A manual claim has no external event to be idempotent against.
    const { ctx, product, warehouse } = await setup();
    const base = {
      productId: product.id, kind: "DAMAGE" as const, assertedBy: "MERCHANT" as const,
      warehouseId: warehouse.id,
    };

    const first = await openClaim(ctx, { ...base, quantity: toQty(3) });
    const second = await openClaim(ctx, { ...base, quantity: toQty(5) });

    expect(second.claimId).not.toBe(first.claimId);
    expect(await prisma.stockClaim.count()).toBe(2);
    expect(await prisma.stockClaimEvent.count()).toBe(2);

    // Both quantities reached the balance. Under the old behaviour the second
    // five units vanished silently.
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.disputedQty).toBe(toQty(8));
    expect(balance.availableQty).toBe(toQty(92));
  });

  it("refuses a resync that changes the quantity instead of dropping the difference", async () => {
    // A corrected Salla figure is a real case. Silently returning the existing
    // claim would lose the extra units.
    const { ctx, product, warehouse } = await setup();
    const base = {
      productId: product.id, kind: "RETURN" as const, assertedBy: "SALLA" as const,
      warehouseId: warehouse.id, sourceKey: "shipment-42",
    };

    await openClaim(ctx, { ...base, quantity: toQty(10) });

    await expect(openClaim(ctx, { ...base, quantity: toQty(12) }))
      .rejects.toMatchObject({ code: "CLAIM_QUANTITY_CONFLICT" });

    expect(await prisma.stockClaim.count()).toBe(1);
  });

  it("keeps different kinds of claim on the same product separate", async () => {
    const { ctx, product, warehouse } = await setup();

    await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });
    await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(3), warehouseId: warehouse.id,
    });

    expect(await prisma.stockClaim.count()).toBe(2);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.disputedQty).toBe(toQty(13));
    // Only the DAMAGE claim came out of available. The RETURN was added.
    expect(balance.availableQty).toBe(toQty(97));
  });
});

describe("settleClaimIn", () => {
  beforeEach(resetDb);

  it("rolls back with its caller's transaction", async () => {
    // Reconciliation settles several claims for one product and then posts
    // that product's shrinkage. While each settlement opened its OWN
    // transaction, a line whose third settlement threw left the first two
    // committed and was still reported as failed.
    const { ctx, product, warehouse } = await soldSetup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });
    const before = await prisma.inventoryBalance.findFirstOrThrow();

    await expect(
      prisma.$transaction(async (tx) => {
        await settleClaimIn(tx, ctx, {
          claimId, quantity: toQty(6), assertedBy: "WAREHOUSE", warehouseId: warehouse.id,
        });
        throw new Error("a later step in the same line failed");
      }),
    ).rejects.toThrow();

    const claim = await prisma.stockClaim.findFirstOrThrow({ where: { id: claimId } });
    expect(claim.settledQty).toBe(0);
    expect(
      await prisma.stockClaimEvent.count({ where: { claimId, eventType: "SETTLED" } }),
    ).toBe(0);

    const after = await prisma.inventoryBalance.findFirstOrThrow();
    expect(after.availableQty).toBe(before.availableQty);
    expect(after.disputedQty).toBe(before.disputedQty);
  });

  it("commits when its caller's transaction commits", async () => {
    const { ctx, product, warehouse } = await soldSetup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    const result = await prisma.$transaction((tx) =>
      settleClaimIn(tx, ctx, {
        claimId, quantity: toQty(6), assertedBy: "WAREHOUSE", warehouseId: warehouse.id,
      }),
    );

    expect(result.openQty).toBe(toQty(4));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(46));
  });
});

describe("settleClaim", () => {
  beforeEach(resetDb);

  it("returns settled units to available and records the event", async () => {
    // 40 on the shelf, 10 returns in dispute. The warehouse confirms 6 of them.
    const { ctx, product, warehouse } = await soldSetup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    const { openQty } = await settleClaim(ctx, {
      claimId, quantity: toQty(6), assertedBy: "WAREHOUSE", warehouseId: warehouse.id,
    });

    expect(openQty).toBe(toQty(4));
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(46));
    expect(balance.disputedQty).toBe(toQty(4));

    const events = await prisma.stockClaimEvent.findMany({
      where: { claimId }, orderBy: { occurredAt: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["OPENED", "SETTLED"]);
    expect(events[1].assertedBy).toBe("WAREHOUSE");
    expect(events[1].quantity).toBe(toQty(6));
  });

  it("refuses to settle more than is open, and writes nothing", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    await expect(settleClaim(ctx, {
      claimId, quantity: toQty(11), assertedBy: "WAREHOUSE", warehouseId: warehouse.id,
    })).rejects.toMatchObject({ code: "CLAIM_SETTLE_EXCEEDS_OPEN" });

    const claim = await prisma.stockClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.settledQty).toBe(0);
    expect(await prisma.stockClaimEvent.count()).toBe(1);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.disputedQty).toBe(toQty(10));
  });

  it("settles a DAMAGE claim into the damaged bucket, not into sellable stock", async () => {
    // The warehouse confirming units DAMAGED must not book them as sellable.
    // Settling every kind back to AVAILABLE meant inventory value ROSE on the
    // confirmation of a loss.
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(3), warehouseId: warehouse.id,
    });

    await settleClaim(ctx, {
      claimId, quantity: toQty(3), assertedBy: "WAREHOUSE",
      warehouseId: warehouse.id, outcome: "DAMAGED",
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.damagedQty).toBe(toQty(3));
    expect(balance.disputedQty).toBe(0);
    // The 3 units left available when the claim opened and must NOT come back.
    expect(balance.availableQty).toBe(toQty(97));
  });

  it("closes the claim when fully settled", async () => {
    const { ctx, product, warehouse } = await soldSetup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    await settleClaim(ctx, {
      claimId, quantity: toQty(10), assertedBy: "WAREHOUSE", warehouseId: warehouse.id,
    });

    const claim = await prisma.stockClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.settledAt).not.toBeNull();
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.disputedQty).toBe(0);
    // 40 on the shelf plus the 10 confirmed back — the spec's expected 50.
    expect(balance.availableQty).toBe(toQty(50));
  });

  it("settles in two parts without losing value", async () => {
    const { ctx, product, warehouse } = await soldSetup();
    const before = await prisma.inventoryBalance.findFirstOrThrow();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    await settleClaim(ctx, { claimId, quantity: toQty(4), assertedBy: "WAREHOUSE", warehouseId: warehouse.id });
    const { openQty } = await settleClaim(ctx, { claimId, quantity: toQty(6), assertedBy: "WAREHOUSE", warehouseId: warehouse.id });

    expect(openQty).toBe(0);
    const after = await prisma.inventoryBalance.findFirstOrThrow();
    expect(after.availableQty).toBe(toQty(50));
    expect(after.avgCost).toBe(before.avgCost);
  });

  it("refuses a claim belonging to another company", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    const other = await makeCompany("Other Co");
    const otherWarehouse = await makeWarehouse(other.id, "THEIRS");

    await expect(settleClaim(makeCtx(other.id), {
      claimId, quantity: toQty(1), assertedBy: "WAREHOUSE", warehouseId: otherWarehouse.id,
    })).rejects.toMatchObject({ code: "CLAIM_NOT_FOUND" });

    const claim = await prisma.stockClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.settledQty).toBe(0);
  });
});

describe("openClaims", () => {
  beforeEach(resetDb);

  it("returns only unsettled claims, with an age in days", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });
    await prisma.stockClaim.update({
      where: { id: claimId },
      data: { openedAt: new Date(Date.now() - 79 * 24 * 60 * 60 * 1000) },
    });

    const open = await openClaims(ctx, {});

    expect(open).toHaveLength(1);
    expect(open[0].openQty).toBe(toQty(10));
    expect(open[0].ageDays).toBe(79);
    expect(open[0].assertedBy).toBe("SALLA");
  });

  it("reports the remaining quantity on a partly settled claim", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });
    await settleClaim(ctx, { claimId, quantity: toQty(6), assertedBy: "WAREHOUSE", warehouseId: warehouse.id });

    const open = await openClaims(ctx, {});

    expect(open).toHaveLength(1);
    expect(open[0].openQty).toBe(toQty(4));
  });

  it("excludes a fully settled claim", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });
    await settleClaim(ctx, { claimId, quantity: toQty(10), assertedBy: "WAREHOUSE", warehouseId: warehouse.id });

    expect(await openClaims(ctx, {})).toHaveLength(0);
  });

  it("filters by product when asked", async () => {
    const { ctx, product, warehouse } = await setup();
    const second = await makeProduct(ctx.companyId, "SKU-2");
    await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });
    await openClaim(ctx, {
      productId: second.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(2), warehouseId: warehouse.id,
    });

    const open = await openClaims(ctx, { productId: product.id });

    expect(open).toHaveLength(1);
    expect(open[0].productId).toBe(product.id);
  });

  it("does not return another company's claims", async () => {
    const { ctx, product, warehouse } = await setup();
    await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(10), warehouseId: warehouse.id,
    });

    const other = await makeCompany("Other Co");
    expect(await openClaims(makeCtx(other.id), {})).toHaveLength(0);
  });
});

describe("cancelClaim", () => {
  beforeEach(resetDb);

  it("takes a withdrawn RETURN back out of dispute without crediting the shelf", async () => {
    // The warehouse says the return is not coming after all. Those units were
    // never on our shelf — they left when they were sold — so cancelling must
    // remove them from dispute and add nothing to available. Posting them to
    // available would mint stock that does not exist.
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(4), warehouseId: warehouse.id,
    });

    await cancelClaim(ctx, { claimId, warehouseId: warehouse.id, assertedBy: "WAREHOUSE" });

    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.disputedQty).toBe(0);
    expect(balance.availableQty).toBe(toQty(100));
    const claim = await prisma.stockClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.settledAt).not.toBeNull();
    const events = await prisma.stockClaimEvent.findMany({ where: { claimId } });
    expect(events.map((e) => e.eventType)).toContain("CANCELLED");
  });

  it("returns a withdrawn DAMAGE claim's units to the shelf they came from", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "DAMAGE", assertedBy: "MERCHANT",
      quantity: toQty(3), warehouseId: warehouse.id,
    });

    await cancelClaim(ctx, { claimId, warehouseId: warehouse.id, assertedBy: "WAREHOUSE" });

    // A DAMAGE claim took them OUT of available when it opened, so cancelling
    // must put them back — unlike a RETURN, which never touched available.
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect(balance.availableQty).toBe(toQty(100));
    expect(balance.disputedQty).toBe(0);
  });

  it("refuses to cancel a claim that has already been partly settled", async () => {
    const { ctx, product, warehouse } = await setup();
    const { claimId } = await openClaim(ctx, {
      productId: product.id, kind: "RETURN", assertedBy: "SALLA",
      quantity: toQty(4), warehouseId: warehouse.id,
    });
    await settleClaim(ctx, {
      claimId, quantity: toQty(1), assertedBy: "WAREHOUSE", warehouseId: warehouse.id,
    });

    // Those settled units already moved into stock. Cancelling the rest is a
    // different operation from undoing what happened, and conflating them
    // would silently reverse a real receipt.
    await expect(cancelClaim(ctx, {
      claimId, warehouseId: warehouse.id, assertedBy: "WAREHOUSE",
    })).rejects.toThrow();
  });
});

import { prisma, type Tx } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { Asserter, ClaimKind } from "@/lib/constants";
import { invalidState } from "@/services/errors";
import { applyMovement, getBalance } from "@/services/inventory";
import { writeAudit } from "@/services/audit";
import { nextNumber } from "@/services/numbering";

/**
 * The claim ledger: disagreements between what the merchant's records say and
 * what the fulfilment warehouse asserts.
 *
 * `StockClaimEvent` is append-only and is the source of truth. `StockClaim` is
 * its rollup — `quantity` and `settledQty` are only ever moved in step with an
 * event write, in the same transaction. Nothing else in the application may
 * write either table.
 *
 * The system never decides who is right. It records that one party asserted
 * something, tracks whether the custodian has confirmed it, and lets the gap
 * age. Picking a side in code would recreate the merchant's problem in
 * software.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Where a claim's units come FROM when it opens.
 *
 * This is not cosmetic — it decides what the reconciliation expects to be on
 * the shelf, which is the whole product.
 *
 * RETURN units were sold and shipped out. They already left availableQty at
 * the point of sale, and they are now coming BACK from the customer. They
 * enter the balance in the disputed bucket; nothing leaves. Expected on-hand
 * therefore RISES by the returned quantity, which is what the design spec's
 * worked example requires: 100 shipped, 60 sold, 50 delivered leaves 40
 * available, and expected on-hand is 50 — the extra 10 being the unconfirmed
 * return.
 *
 * DAMAGE and SHORTAGE units are the opposite. They are already counted in
 * availableQty and their existence has been called into question, so they move
 * across from AVAILABLE and expected on-hand is unchanged.
 *
 * Getting this backwards for RETURN would understate expected stock by exactly
 * the quantity the merchant is trying to recover.
 */
const CLAIM_TAKES_FROM_AVAILABLE: Record<ClaimKind, boolean> = {
  RETURN: false,
  DAMAGE: true,
  SHORTAGE: true,
};

const CLAIM_MOVEMENT_REF = "STOCK_CLAIM";

/**
 * Post one leg of a bucket move at the balance's existing average cost.
 *
 * DISPUTED does not move the weighted average (BUCKET_MOVES_AVERAGE in
 * inventory.ts), and neither does an OUT, so total owned value is conserved
 * across both legs. A disputed unit was bought and averaged when it arrived;
 * this is a reclassification of stock already owned, not a purchase.
 */
async function postClaimLeg(
  tx: Tx,
  ctx: ServiceContext,
  input: {
    warehouseId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    direction: "IN" | "OUT";
    bucket: "AVAILABLE" | "DISPUTED" | "DAMAGED";
    unitCost: number;
    referenceId: string;
    referenceNumber: string;
    reason: string;
  },
) {
  const common = {
    warehouseId: input.warehouseId,
    productId: input.productId,
    variantId: input.variantId,
    quantity: input.quantity,
    bucket: input.bucket,
    referenceType: CLAIM_MOVEMENT_REF,
    referenceId: input.referenceId,
    referenceNumber: input.referenceNumber,
    reason: input.reason,
  } as const;

  if (input.direction === "IN") {
    return applyMovement(tx, ctx, {
      ...common,
      movementType: "ADJUSTMENT_IN",
      direction: "IN",
      unitCost: input.unitCost,
    });
  }
  return applyMovement(tx, ctx, {
    ...common,
    movementType: "ADJUSTMENT_OUT",
    direction: "OUT",
  });
}

export async function openClaim(
  ctx: ServiceContext,
  input: {
    productId: string;
    variantId?: string | null;
    kind: ClaimKind;
    assertedBy: Asserter;
    quantity: number;
    sourceKey?: string;
    warehouseId: string;
    notes?: string | null;
  },
): Promise<{ claimId: string }> {
  if (input.quantity <= 0) {
    throw invalidState("CLAIM_INVALID_QUANTITY", { quantity: input.quantity });
  }

  return prisma.$transaction(async (tx) => {
    const variantKey = input.variantId ?? "";

    // A supplied sourceKey is an IDEMPOTENCY key: it identifies a real external
    // event (a Salla shipment, say), so a resync must find the same claim
    // rather than double-claiming.
    //
    // Its ABSENCE means a manual claim, which has no external event to key on.
    // Those get a fresh generated key so every entry is its own claim.
    // Sharing "" across them made the compound unique match, so three units
    // damaged on Monday and five more on Friday collapsed into one claim for
    // three — the second call returned the first's id having written no event,
    // no movement and no quantity, and reported success. sourceKey is still
    // non-null throughout, because SQLite does not collide NULLs in a unique
    // index and a nullable column there would constrain nothing at all.
    const sourceKey = input.sourceKey ?? `manual:${crypto.randomUUID()}`;

    if (input.sourceKey) {
      const existing = await tx.stockClaim.findUnique({
        where: {
          companyId_kind_sourceKey_productId_variantKey: {
            companyId: ctx.companyId,
            kind: input.kind,
            sourceKey,
            productId: input.productId,
            variantKey,
          },
        },
      });
      if (existing) {
        // A resync that corrects the quantity is a real case and silently
        // dropping the difference would lose units. Refuse rather than guess.
        if (existing.quantity !== input.quantity) {
          throw invalidState("CLAIM_QUANTITY_CONFLICT", {
            claimId: existing.id,
            existing: existing.quantity,
            incoming: input.quantity,
          });
        }
        return { claimId: existing.id };
      }
    }

    // Ownership gate. applyMovement re-checks below, but a claim row must never
    // be created for another tenant's product even if the movement were to fail
    // for some other reason first.
    await tx.product.findFirstOrThrow({
      where: { id: input.productId, companyId: ctx.companyId },
    });

    const claim = await tx.stockClaim.create({
      data: {
        companyId: ctx.companyId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        variantKey,
        kind: input.kind,
        assertedBy: input.assertedBy,
        sourceKey,
        // The claim disputes THIS warehouse's balance and reconciliation
        // scopes by it; a claim opened at B must never inflate A's shelf.
        warehouseId: input.warehouseId,
        quantity: input.quantity,
        notes: input.notes ?? null,
      },
    });

    await tx.stockClaimEvent.create({
      data: {
        companyId: ctx.companyId,
        claimId: claim.id,
        eventType: "OPENED",
        quantity: input.quantity,
        assertedBy: input.assertedBy,
        notes: input.notes ?? null,
      },
    });

    const referenceNumber = await nextNumber(tx, ctx.companyId, "CLM");
    const balance = await getBalance(
      tx, ctx.companyId, input.warehouseId, input.productId, input.variantId ?? null,
    );
    const leg = {
      warehouseId: input.warehouseId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      quantity: input.quantity,
      unitCost: balance.avgCost,
      referenceId: claim.id,
      referenceNumber,
      reason: `Claim opened by ${input.assertedBy}`,
    };

    if (CLAIM_TAKES_FROM_AVAILABLE[input.kind]) {
      await postClaimLeg(tx, ctx, { ...leg, direction: "OUT", bucket: "AVAILABLE" });
    }
    await postClaimLeg(tx, ctx, { ...leg, direction: "IN", bucket: "DISPUTED" });

    await writeAudit(tx, ctx, {
      action: "CLAIM_OPENED",
      entityType: "StockClaim",
      entityId: claim.id,
      newValues: {
        kind: input.kind,
        assertedBy: input.assertedBy,
        quantity: input.quantity,
        productId: input.productId,
      },
    });

    return { claimId: claim.id };
  });
}

export async function settleClaim(
  ctx: ServiceContext,
  input: {
    claimId: string;
    quantity: number;
    assertedBy: Asserter;
    warehouseId: string;
    /**
     * What the custodian confirmed the units to BE, which is not the same
     * question as which claim they answer.
     *
     * SELLABLE returns them to available stock. DAMAGED writes them off into
     * the damaged bucket, which carries no cost basis (docs/decisions.md #7).
     *
     * Defaulting this to SELLABLE for every kind was a real defect: the
     * warehouse confirming three units DAMAGED settled the claim by booking
     * those units as sellable at full avgCost, so inventory value ROSE on the
     * confirmation of a loss.
     */
    outcome?: "SELLABLE" | "DAMAGED";
    notes?: string | null;
  },
): Promise<{ claimId: string; openQty: number }> {
  return prisma.$transaction((tx) => settleClaimIn(tx, ctx, input));
}

/**
 * The body of `settleClaim`, taking a transaction instead of opening one.
 *
 * Reconciliation settles several claims for one product and then posts that
 * product's shrinkage. With each settlement in its own transaction, a line
 * whose third settlement threw left the first two committed while the line was
 * reported as failed. Passing one transaction through makes the LINE
 * all-or-nothing, which is the unit the merchant actually acts on.
 */
export async function settleClaimIn(
  tx: Tx,
  ctx: ServiceContext,
  input: {
    claimId: string;
    quantity: number;
    assertedBy: Asserter;
    warehouseId: string;
    outcome?: "SELLABLE" | "DAMAGED";
    notes?: string | null;
  },
): Promise<{ claimId: string; openQty: number }> {
  if (input.quantity <= 0) {
    throw invalidState("CLAIM_INVALID_QUANTITY", { quantity: input.quantity });
  }

  {
    const claim = await tx.stockClaim.findFirst({
      where: { id: input.claimId, companyId: ctx.companyId },
    });
    if (!claim) throw invalidState("CLAIM_NOT_FOUND", { claimId: input.claimId });

    const openQty = claim.quantity - claim.settledQty;
    if (input.quantity > openQty) {
      throw invalidState("CLAIM_SETTLE_EXCEEDS_OPEN", {
        claimId: claim.id,
        requested: input.quantity,
        open: openQty,
      });
    }

    await tx.stockClaimEvent.create({
      data: {
        companyId: ctx.companyId,
        claimId: claim.id,
        eventType: "SETTLED",
        quantity: input.quantity,
        assertedBy: input.assertedBy,
        notes: input.notes ?? null,
      },
    });

    const settledQty = claim.settledQty + input.quantity;
    const remaining = claim.quantity - settledQty;
    await tx.stockClaim.update({
      where: { id: claim.id },
      data: {
        settledQty,
        settledAt: remaining === 0 ? new Date() : null,
      },
    });

    const outcome = input.outcome ?? "SELLABLE";
    const referenceNumber = await nextNumber(tx, ctx.companyId, "CLM");
    const balance = await getBalance(
      tx, ctx.companyId, input.warehouseId, claim.productId, claim.variantId,
    );
    const leg = {
      warehouseId: input.warehouseId,
      productId: claim.productId,
      variantId: claim.variantId,
      quantity: input.quantity,
      unitCost: balance.avgCost,
      referenceId: claim.id,
      referenceNumber,
      reason: `Claim settled by ${input.assertedBy} as ${outcome}`,
    };
    await postClaimLeg(tx, ctx, { ...leg, direction: "OUT", bucket: "DISPUTED" });
    await postClaimLeg(tx, ctx, {
      ...leg,
      direction: "IN",
      bucket: outcome === "DAMAGED" ? "DAMAGED" : "AVAILABLE",
    });

    await writeAudit(tx, ctx, {
      action: "CLAIM_SETTLED",
      entityType: "StockClaim",
      entityId: claim.id,
      newValues: {
        quantity: input.quantity, assertedBy: input.assertedBy, outcome, remaining,
      },
    });

    return { claimId: claim.id, openQty: remaining };
  }
}

/**
 * Withdraws a claim that will never be settled — the warehouse rejected the
 * return, or the merchant was wrong about the damage.
 *
 * This is the exact REVERSE of opening, which is why it consults the same
 * table: a RETURN never left available, so cancelling must not credit it
 * (that would mint stock that was sold and is not coming back), while a
 * DAMAGE claim did leave available and must be put back.
 *
 * A partly-settled claim cannot be cancelled: those units already moved into
 * real stock, and undoing a receipt is a different operation from abandoning
 * a dispute.
 */
export async function cancelClaim(
  ctx: ServiceContext,
  input: {
    claimId: string;
    warehouseId: string;
    assertedBy: Asserter;
    notes?: string | null;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.stockClaim.findFirstOrThrow({
      where: { id: input.claimId, companyId: ctx.companyId },
    });
    if (claim.settledAt) throw invalidState("CLAIM_ALREADY_SETTLED", { claimId: claim.id });
    if (claim.settledQty > 0) {
      throw invalidState("CLAIM_PARTLY_SETTLED", {
        claimId: claim.id, settledQty: claim.settledQty,
      });
    }

    const open = claim.quantity - claim.settledQty;

    await tx.stockClaimEvent.create({
      data: {
        companyId: ctx.companyId,
        claimId: claim.id,
        eventType: "CANCELLED",
        quantity: open,
        assertedBy: input.assertedBy,
        notes: input.notes ?? null,
      },
    });
    await tx.stockClaim.update({
      where: { id: claim.id },
      data: { settledAt: new Date() },
    });

    const referenceNumber = await nextNumber(tx, ctx.companyId, "CLM");
    const balance = await getBalance(
      tx, ctx.companyId, input.warehouseId, claim.productId, claim.variantId,
    );
    const leg = {
      warehouseId: input.warehouseId,
      productId: claim.productId,
      variantId: claim.variantId,
      quantity: open,
      unitCost: balance.avgCost,
      referenceId: claim.id,
      referenceNumber,
      reason: `Claim cancelled by ${input.assertedBy}`,
    };
    await postClaimLeg(tx, ctx, { ...leg, direction: "OUT", bucket: "DISPUTED" });
    if (CLAIM_TAKES_FROM_AVAILABLE[claim.kind as ClaimKind]) {
      await postClaimLeg(tx, ctx, { ...leg, direction: "IN", bucket: "AVAILABLE" });
    }

    await writeAudit(tx, ctx, {
      action: "CLAIM_CANCELLED",
      entityType: "StockClaim",
      entityId: claim.id,
      newValues: { quantity: open, assertedBy: input.assertedBy },
    });
  });
}

export async function openClaims(
  ctx: ServiceContext,
  input: { productId?: string },
): Promise<
  Array<{
    claimId: string;
    productId: string;
    variantId: string | null;
    kind: ClaimKind;
    assertedBy: Asserter;
    openQty: number;
    ageDays: number;
    openedAt: Date;
  }>
> {
  const claims = await prisma.stockClaim.findMany({
    where: {
      companyId: ctx.companyId,
      settledAt: null,
      ...(input.productId ? { productId: input.productId } : {}),
    },
    orderBy: { openedAt: "asc" },
  });

  const now = Date.now();
  return claims.map((claim) => ({
    claimId: claim.id,
    productId: claim.productId,
    variantId: claim.variantId,
    kind: claim.kind as ClaimKind,
    assertedBy: claim.assertedBy as Asserter,
    // Derived, never stored. StockClaim is a rollup of the event log and a
    // second stored copy of this number would drift from it.
    openQty: claim.quantity - claim.settledQty,
    ageDays: Math.floor((now - claim.openedAt.getTime()) / MS_PER_DAY),
    openedAt: claim.openedAt,
  }));
}

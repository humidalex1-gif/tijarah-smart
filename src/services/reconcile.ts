import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { ClaimKind } from "@/lib/constants";
import { invalidState } from "@/services/errors";
import { applyMovement } from "@/services/inventory";
import { settleClaimIn } from "@/services/claims";
import { writeAudit } from "@/services/audit";
import { nextNumber } from "@/services/numbering";

/**
 * Reconciling the merchant's ledger against what the fulfilment warehouse says
 * is on its shelf.
 *
 * The product is not the difference. It is the DECOMPOSITION of the
 * difference: which part is explained by returns and damage the warehouse has
 * never confirmed, and which part is unexplained and therefore a real loss.
 * "You are 13 short" is not actionable; "10 of those are returns you never
 * booked, and 3 are gone" is.
 *
 * Sellable and damaged are compared SEPARATELY and never summed into one
 * figure. An earlier version added them together, which produced two defects
 * at once: a warehouse confirming damage settled those units back into
 * sellable stock at full cost (so inventory value ROSE on a loss), and an
 * asserted damaged figure never reached damagedQty at all — its only effect
 * was to cancel out the shrinkage that should have been recognised.
 */

/** Which bucket a settled claim's units belong in once the custodian confirms them. */
const CLAIM_SETTLES_AS: Record<ClaimKind, "SELLABLE" | "DAMAGED"> = {
  RETURN: "SELLABLE",
  SHORTAGE: "SELLABLE",
  DAMAGE: "DAMAGED",
};

export type ReconcileLine = {
  productId: string;
  variantId: string | null;
  /** availableQty + disputed units expected back as sellable. */
  expectedSellable: number;
  /** damagedQty + disputed units expected to be confirmed damaged. */
  expectedDamaged: number;
  assertedSellable: number;
  assertedDamaged: number | null;
  /** expectedSellable - assertedSellable. Negative means they hold more. */
  gap: number;
  /** Disputed units the sellable assertion accounts for, so their claims close. */
  settleableSellable: number;
  /** Disputed DAMAGE units the damaged assertion accounts for. */
  settleableDamaged: number;
  /** Disputed units the assertion still does not account for. */
  stillClaimed: number;
  /** Shelf units missing with no claim behind them. Real shrinkage. */
  unexplained: number;
  /** Units held beyond expectation. */
  surplus: number;
  /**
   * Units the warehouse now reports as damaged beyond what the books already
   * wrote off. `damagedReturns` of these are settled out of dispute; the rest
   * is posted as an AVAILABLE -> DAMAGED reclassification.
   */
  damagedDelta: number;
  /**
   * The part of `damagedDelta` attributed to disputed returns that came back
   * broken, settled DISPUTED -> DAMAGED. Owner's ruling, 2026-08-05.
   */
  damagedReturns: number;
  /** False when the arithmetic cannot attribute the difference. */
  determinate: boolean;
};

type InputLine = {
  productId: string;
  variantId?: string | null;
  sellable: number;
  damaged?: number | null;
};

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

/**
 * Decompose one line.
 *
 * The sellable assertion is compared against the SHELF portion (availableQty),
 * not against a total, which is what makes these come out right for
 * available 40, disputed-sellable 10, expected 50:
 *
 *   asserted 37 -> settle 0,  still claimed 10, unexplained 3
 *   asserted 45 -> settle 5,  still claimed 5,  unexplained 0
 *   asserted 50 -> settle 10, still claimed 0,  unexplained 0
 *   asserted 55 -> settle 10, surplus 5
 *
 * Deriving the settleable portion from the gap instead breaks the third case:
 * asserting exactly the expected quantity gives a gap of zero, so nothing
 * would settle and the claims the warehouse had just confirmed would stay open
 * and age forever.
 */
function decompose(input: {
  availableQty: number;
  damagedQty: number;
  disputedSellable: number;
  disputedDamage: number;
  assertedSellable: number;
  assertedDamaged: number | null;
  openClaimKinds: number;
}) {
  const expectedSellable = input.availableQty + input.disputedSellable;
  const expectedDamaged = input.damagedQty + input.disputedDamage;

  // Deliberate asymmetry: sellable-kind claims (returns, shortages) settle on
  // the warehouse's say-so because their assertion IS the confirmation, but a
  // DAMAGE claim the warehouse refutes — more sellable on the shelf than the
  // books plus claims explain — surfaces as `surplus` for the merchant to
  // judge, and the claim stays open. The system never closes a dispute in the
  // merchant's favour on its own.
  const settleableSellable = clamp(
    input.assertedSellable - input.availableQty, 0, input.disputedSellable,
  );
  const surplus = Math.max(0, input.assertedSellable - expectedSellable);

  // Damaged is only decomposed when the warehouse actually reported it. A null
  // means "they did not say", which is not the same as "they said zero" — and
  // treating it as zero would post a reclassification reversing real damage.
  const settleableDamaged = input.assertedDamaged === null
    ? 0
    : clamp(input.assertedDamaged - input.damagedQty, 0, input.disputedDamage);

  // Damage beyond what the books already carry AND beyond what open DAMAGE
  // claims cover is stock that was sellable and is not any more.
  const damagedDelta = input.assertedDamaged === null
    ? 0
    : Math.max(0, input.assertedDamaged - expectedDamaged);

  // Where can the extra damage have come FROM? Only two places, and the shelf
  // gets first claim on it because a short shelf is the simpler story: units
  // that were sellable yesterday and are broken today.
  const shelfShortfall = Math.max(0, input.availableQty - input.assertedSellable);
  const damagedFromShelf = Math.min(damagedDelta, shelfShortfall);

  // What is left cannot have come off a shelf the warehouse just said is not
  // short. It is the disputed returns, come back broken — the owner's ruling
  // of 2026-08-05. Writing it off the shelf instead (what this did before)
  // destroys intact stock on paper AND leaves the return claim open to age
  // forever, so the same units are punished twice.
  const damagedReturns = Math.min(
    damagedDelta - damagedFromShelf,
    input.disputedSellable - settleableSellable,
  );

  // The damaged reclassification EXPLAINS part of the shelf shortfall; it is
  // not additional to it. Those are the same physical units — sellable
  // yesterday, damaged today — so counting them twice takes 10 units off a
  // 5-unit shortfall and leaves the balance short by the damaged quantity.
  // Only the shelf-sourced part explains anything: damage attributed to a
  // return never stood on the shelf to begin with.
  const unexplained = Math.max(
    0, input.availableQty - input.assertedSellable - damagedFromShelf,
  );

  const stillClaimed =
    (input.disputedSellable - settleableSellable - damagedReturns) +
    (input.disputedDamage - settleableDamaged);

  // Spec 3.2. One combined figure cannot attribute the difference when more
  // than one kind of claim is outstanding: with 10 returns and 4 damages
  // pending, an observed shortfall is equally consistent with several stories
  // and no arithmetic separates them. Two figures make it determined.
  const determinate = input.assertedDamaged !== null || input.openClaimKinds <= 1;

  return {
    expectedSellable,
    expectedDamaged,
    gap: expectedSellable - input.assertedSellable,
    settleableSellable,
    settleableDamaged,
    stillClaimed,
    unexplained,
    surplus,
    damagedDelta,
    damagedReturns,
    determinate,
  };
}

/**
 * Read balances and open claims for the requested products in batched queries
 * rather than one pair per line. postStockCount's own comment records why: a
 * whole-catalogue run of per-line reads approaches Prisma's five-second
 * interactive-transaction limit.
 */
async function loadContext(
  ctx: ServiceContext,
  warehouseId: string,
  lines: InputLine[],
) {
  // Tenant gate. A foreign warehouse must resolve to nothing, never to
  // everything. Kept even though the product check below would also catch a
  // foreign id — each gate must stand on its own.
  await prisma.warehouse.findFirstOrThrow({
    where: { id: warehouseId, companyId: ctx.companyId },
  });

  const productIds = [...new Set(lines.map((l) => l.productId))];
  const owned = await prisma.product.findMany({
    where: { id: { in: productIds }, companyId: ctx.companyId },
    select: { id: true },
  });
  if (owned.length !== productIds.length) {
    throw invalidState("NOT_FOUND", { entity: "Product" });
  }

  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId: ctx.companyId, warehouseId, productId: { in: productIds } },
  });
  const claims = await prisma.stockClaim.findMany({
    where: {
      companyId: ctx.companyId,
      productId: { in: productIds },
      settledAt: null,
      // Scoped to the warehouse being reconciled. A null warehouseId is a
      // legacy row from before the column existed; it is counted here rather
      // than dropped, so pre-push claims keep working against the (single)
      // real warehouse instead of silently vanishing from every screen.
      OR: [{ warehouseId }, { warehouseId: null }],
    },
  });

  const key = (productId: string, variantKey: string) => `${productId}:${variantKey}`;
  const balanceBy = new Map(balances.map((b) => [key(b.productId, b.variantKey), b]));
  const claimsBy = new Map<string, typeof claims>();
  for (const claim of claims) {
    const k = key(claim.productId, claim.variantKey);
    const list = claimsBy.get(k) ?? [];
    list.push(claim);
    claimsBy.set(k, list);
  }

  return { balanceBy, claimsBy, key };
}

type LoadedContext = Awaited<ReturnType<typeof loadContext>>;

function buildLines(input: { lines: InputLine[] }, loaded: LoadedContext): ReconcileLine[] {
  return input.lines.map((line) => {
    const variantKey = line.variantId ?? "";
    const k = loaded.key(line.productId, variantKey);
    const balance = loaded.balanceBy.get(k);
    const claims = loaded.claimsBy.get(k) ?? [];
    const kinds = new Set<ClaimKind>(claims.map((c) => c.kind as ClaimKind));

    const open = (claim: (typeof claims)[number]) => claim.quantity - claim.settledQty;
    const disputedDamage = claims
      .filter((c) => CLAIM_SETTLES_AS[c.kind as ClaimKind] === "DAMAGED")
      .reduce((sum, c) => sum + open(c), 0);
    const disputedSellable = claims
      .filter((c) => CLAIM_SETTLES_AS[c.kind as ClaimKind] === "SELLABLE")
      .reduce((sum, c) => sum + open(c), 0);

    const parts = decompose({
      availableQty: balance?.availableQty ?? 0,
      damagedQty: balance?.damagedQty ?? 0,
      disputedSellable,
      disputedDamage,
      assertedSellable: line.sellable,
      assertedDamaged: line.damaged ?? null,
      openClaimKinds: kinds.size,
    });

    return {
      productId: line.productId,
      variantId: line.variantId ?? null,
      assertedSellable: line.sellable,
      assertedDamaged: line.damaged ?? null,
      ...parts,
    };
  });
}

export async function previewReconcile(
  ctx: ServiceContext,
  input: { warehouseId: string; asOf: Date; lines: InputLine[] },
): Promise<ReconcileLine[]> {
  const loaded = await loadContext(ctx, input.warehouseId, input.lines);
  return buildLines(input, loaded);
}

export async function postReconcile(
  ctx: ServiceContext,
  input: {
    warehouseId: string;
    asOf: Date;
    isPhysicalCount: boolean;
    lines: InputLine[];
  },
): Promise<{
  settledClaims: number;
  shrinkagePosted: number;
  damagedPosted: number;
  /** Lines the arithmetic could not attribute. Deliberate, not an error. */
  skipped: number;
  /** Lines that threw. A real failure, reported separately from `skipped`. */
  failed: number;
  isPhysicalCount: boolean;
}> {
  if (input.lines.length === 0) throw invalidState("RECONCILE_NO_LINES");

  // Two lines for the same product would each carry the full unexplained
  // quantity computed from the same snapshot, and both would post — double
  // counting the loss. The UI cannot produce this but the action accepts an
  // arbitrary JSON array.
  const seen = new Set<string>();
  for (const line of input.lines) {
    const k = `${line.productId}:${line.variantId ?? ""}`;
    if (seen.has(k)) throw invalidState("RECONCILE_DUPLICATE_LINE", { productId: line.productId });
    seen.add(k);
  }

  // One load, not two. previewReconcile used to be called here and repeated
  // every query including both tenant gates.
  const loaded = await loadContext(ctx, input.warehouseId, input.lines);
  const preview = buildLines(input, loaded);

  // Created before the lines and outside their transactions, so every line's
  // movements can point at it. A run where every line then fails leaves a
  // session with nothing attached, which is harmless — it records that a
  // reconciliation was attempted, which is true.
  const session = await prisma.reconciliationSession.create({
    data: {
      companyId: ctx.companyId,
      warehouseId: input.warehouseId,
      asOf: input.asOf,
      isPhysicalCount: input.isPhysicalCount,
    },
  });

  let settledClaims = 0;
  let shrinkagePosted = 0;
  let damagedPosted = 0;
  let skipped = 0;
  let failed = 0;

  // One transaction PER LINE, not one over all of them: a whole-catalogue run
  // in a single interactive transaction risks Prisma's timeout, and one
  // refused line must not discard every other line's work.
  //
  // Within a line it is all-or-nothing. Every settlement and the shrinkage and
  // damage movements share the one transaction, so a line whose third
  // settlement throws leaves nothing behind — previously the first two
  // committed while the line was still reported as failed.
  for (const line of preview) {
    if (!line.determinate) {
      skipped += 1;
      continue;
    }

    try {
      const claims = loaded.claimsBy.get(
        loaded.key(line.productId, line.variantId ?? ""),
      ) ?? [];
      // Oldest first: the longest-outstanding claim is the one the merchant has
      // been chasing, and closing it is what stops the ageing clock.
      const oldest = [...claims].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

      // Counted inside the transaction, added to the running totals only after
      // it commits. Incrementing as we went reported settlements that a later
      // throw had already rolled back.
      let lineSettled = 0;

      // Which claims to draw from, and what to call the outcome. The third
      // pass is the owner's 2026-08-05 ruling: sellable-KIND claims (returns)
      // settled as DAMAGED, because the warehouse reported damage that a
      // shelf it says is not short cannot account for. It runs last so a
      // return the warehouse confirmed back on the shelf closes as sellable
      // before any of it is called broken.
      const passes = [
        { kind: "SELLABLE", outcome: "SELLABLE", quantity: line.settleableSellable },
        { kind: "DAMAGED", outcome: "DAMAGED", quantity: line.settleableDamaged },
        { kind: "SELLABLE", outcome: "DAMAGED", quantity: line.damagedReturns },
      ] as const;

      // Two passes now draw on the SAME claims, so the open quantity cannot be
      // read from the loaded snapshot alone — it would still show the units
      // the first pass already took and `settleClaimIn` would refuse the line.
      const consumed = new Map<string, number>();

      await prisma.$transaction(async (tx) => {
        for (const pass of passes) {
          let remaining = pass.quantity;
          if (remaining <= 0) continue;

          for (const claim of oldest) {
            if (remaining <= 0) break;
            if (CLAIM_SETTLES_AS[claim.kind as ClaimKind] !== pass.kind) continue;
            const open = claim.quantity - claim.settledQty - (consumed.get(claim.id) ?? 0);
            const take = Math.min(open, remaining);
            if (take <= 0) continue;
            await settleClaimIn(tx, ctx, {
              claimId: claim.id,
              quantity: take,
              assertedBy: "WAREHOUSE",
              warehouseId: input.warehouseId,
              outcome: pass.outcome,
            });
            consumed.set(claim.id, (consumed.get(claim.id) ?? 0) + take);
            lineSettled += take;
            remaining -= take;
          }
        }

        if (line.unexplained > 0 || line.damagedDelta > 0) {
          const reasonSuffix = input.isPhysicalCount
            ? "physical count"
            : "warehouse system figure";

          if (line.unexplained > 0) {
            const referenceNumber = await nextNumber(tx, ctx.companyId, "RCN");
            await applyMovement(tx, ctx, {
              warehouseId: input.warehouseId,
              productId: line.productId,
              variantId: line.variantId,
              movementType: "ADJUSTMENT_OUT",
              direction: "OUT",
              bucket: "AVAILABLE",
              quantity: line.unexplained,
              referenceType: "RECONCILIATION",
              // The session, not a synthetic composite: this is the join the
              // profit report uses to learn whether the figures came from a
              // physical count.
              referenceId: session.id,
              referenceNumber,
              // Dated asOf, not today: a June shelf reconciled in July must
              // land its loss in June, or the profit report attributes it to
              // the wrong month.
              movementDate: input.asOf,
              reason: `Reconciliation shortfall (${reasonSuffix})`,
            });
          }

          // Only the part the shelf can account for. The rest left dispute for
          // the damaged bucket in the settle passes above, and reclassifying
          // it here as well would write the same units off twice.
          const damagedFromShelf = line.damagedDelta - line.damagedReturns;
          if (damagedFromShelf > 0) {
            // Sellable stock the warehouse now reports as damaged. Two legs so
            // it is a reclassification, not a disappearance: DAMAGED carries no
            // cost basis (docs/decisions.md #7), so the value is written off.
            const damagedRef = await nextNumber(tx, ctx.companyId, "RCN");
            const common = {
              warehouseId: input.warehouseId,
              productId: line.productId,
              variantId: line.variantId,
              quantity: damagedFromShelf,
              referenceType: "RECONCILIATION",
              referenceId: session.id,
              referenceNumber: damagedRef,
              movementDate: input.asOf,
              reason: `Reconciliation damage (${reasonSuffix})`,
            } as const;
            const out = await applyMovement(tx, ctx, {
              ...common, movementType: "ADJUSTMENT_OUT", direction: "OUT", bucket: "AVAILABLE",
            });
            await applyMovement(tx, ctx, {
              ...common, movementType: "DAMAGED", direction: "IN", bucket: "DAMAGED",
              unitCost: out.unitCost,
            });
          }

          await writeAudit(tx, ctx, {
            action: "RECONCILIATION_POSTED",
            entityType: "Product",
            entityId: line.productId,
            newValues: {
              asOf: input.asOf.toISOString(),
              isPhysicalCount: input.isPhysicalCount,
              assertedSellable: line.assertedSellable,
              assertedDamaged: line.assertedDamaged,
              unexplained: line.unexplained,
              damagedDelta: line.damagedDelta,
              damagedReturns: line.damagedReturns,
            },
          });
        }
      });

      // Committed. Only now do the reported figures move.
      settledClaims += lineSettled;
      shrinkagePosted += line.unexplained;
      damagedPosted += line.damagedDelta;
    } catch (error) {
      // Logged, not swallowed. An unlogged catch makes a systematic failure —
      // a constraint violation, a timeout, an insufficient-stock throw because
      // stock moved under the preview — indistinguishable from a line the
      // arithmetic deliberately refused, and the merchant sees one number for
      // both.
      console.error("Reconciliation line failed:", line.productId, error);
      failed += 1;
    }
  }

  return {
    settledClaims,
    shrinkagePosted,
    damagedPosted,
    skipped,
    failed,
    isPhysicalCount: input.isPhysicalCount,
  };
}

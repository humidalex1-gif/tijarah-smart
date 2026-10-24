import { allocate, unitCostFrom, roundHalfUp } from "@/lib/money";
import type { AllocationMethod } from "@/lib/constants";
import { invalidState, ServiceError } from "@/services/errors";

/**
 * Weighted average cost, per the requirements:
 *   new avg = ((oldQty x oldAvg) + (receivedQty x receivedCost)) / (oldQty + receivedQty)
 * Quantities are scaled the same way on both sides, so the scale cancels out
 * and the result stays in COST_SCALE units.
 */
export function newAverageCost(input: {
  oldQty: number;
  oldAvgCost: number;
  receivedQty: number;
  receivedUnitCost: number;
}): number {
  const { oldQty, oldAvgCost, receivedQty, receivedUnitCost } = input;
  // A negative received cost has no meaning and would drag the running average
  // down silently. Nothing produces one today — but a credit-note adjustment or
  // a write-down would, and this is the one function whose output can never be
  // recomputed from the ledger (InventoryMovement records unitCost but the
  // average is only ever the running result of every IN).
  if (receivedUnitCost < 0) {
    throw invalidState("INVALID_UNIT_COST", { receivedUnitCost });
  }
  if (receivedQty <= 0) return oldAvgCost;
  if (oldQty <= 0) return receivedUnitCost;

  const totalQty = oldQty + receivedQty;
  const totalValue = oldQty * oldAvgCost + receivedQty * receivedUnitCost;
  if (!Number.isSafeInteger(totalValue)) throw new ServiceError("AMOUNT_OUT_OF_RANGE");
  // roundHalfUp, not Math.round: every other money helper in src/lib/money.ts
  // uses it because Math.round biases negatives toward +inf. This function was
  // the only exception. Unreachable while costs are non-negative (guarded
  // above), fixed anyway so the whole codebase rounds one way.
  return roundHalfUp(totalValue / totalQty);
}

export interface AllocationLine {
  /** scaled quantity (thousandths) */
  quantity: number;
  /** line value in minor units, after discount */
  lineValue: number;
  /** unit weight in grams */
  weightGrams: number;
  /** relative share for MANUAL allocation */
  manualShare?: number;
}

/** Distribute `totalCost` (minor units) across lines using the chosen method. */
export function allocateCost(
  totalCost: number,
  method: AllocationMethod,
  lines: AllocationLine[],
): number[] {
  const weights = lines.map((line) => {
    switch (method) {
      case "QUANTITY":
        return line.quantity;
      case "VALUE":
        return line.lineValue;
      case "WEIGHT":
        return line.weightGrams * line.quantity;
      case "EQUAL":
        return 1;
      case "MANUAL":
        // Not implemented until Stage 2 adds storage for manual splits.
        // createPurchaseOrder already refuses MANUAL, so this is only
        // reachable via a direct DB write — throw rather than let the
        // all-zero weights silently degrade to an equal split.
        throw invalidState("MANUAL_ALLOCATION_NOT_SUPPORTED");
      default:
        // Unreachable for a value that actually typechecks as
        // AllocationMethod, but `method` can arrive as a plain string from
        // the database (po.allocationMethod cast) or an unvalidated caller —
        // guard against silently equal-splitting on a corrupt value.
        throw invalidState("INVALID_ALLOCATION_METHOD", { method });
    }
  });
  return allocate(totalCost, weights);
}

/** (base line cost + allocated additional cost) / quantity -> scaled unit cost */
export function landedUnitCost(
  baseLineCost: number,
  allocatedCost: number,
  qty: number,
): number {
  return unitCostFrom(baseLineCost + allocatedCost, qty);
}

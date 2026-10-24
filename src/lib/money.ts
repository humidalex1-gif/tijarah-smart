/**
 * All money is stored as integers in minor currency units (e.g. halalas).
 * All quantities are stored as integers in thousandths (QTY_SCALE).
 * All unit costs are stored as minor units scaled by COST_SCALE (4 dp).
 * Nothing in this file may use floating point for stored values.
 */

import { ServiceError } from "@/services/errors";

export const QTY_SCALE = 1000;
export const COST_SCALE = 10_000;

/**
 * Round half away from zero — JS Math.round biases negatives toward +inf.
 *
 * Exported so `newAverageCost` (src/services/costing.ts) can share it. That
 * function was rounding with bare Math.round, the only money arithmetic in the
 * codebase that did.
 */
export function roundHalfUp(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export function toQty(value: number | string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) throw new ServiceError("INVALID_QUANTITY");
  return roundHalfUp(n * QTY_SCALE);
}

export function fromQty(qty: number): number {
  return qty / QTY_SCALE;
}

export function toMinor(value: number | string, decimals = 2): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) throw new ServiceError("INVALID_AMOUNT");
  return roundHalfUp(n * 10 ** decimals);
}

export function fromMinor(minor: number, decimals = 2): number {
  return minor / 10 ** decimals;
}

/** minor units per unit -> scaled unit cost */
export function toCost(minorPerUnit: number): number {
  return roundHalfUp(minorPerUnit * COST_SCALE);
}

/** scaled unit cost -> minor units per unit */
export function fromCost(cost: number): number {
  return cost / COST_SCALE;
}

/** scaled quantity x scaled unit cost -> total in minor units */
export function costOf(qty: number, unitCost: number): number {
  const product = qty * unitCost;
  if (!Number.isSafeInteger(product)) throw new ServiceError("AMOUNT_OUT_OF_RANGE");
  return roundHalfUp(product / (QTY_SCALE * COST_SCALE));
}

/** total in minor units / scaled quantity -> scaled unit cost */
export function unitCostFrom(totalMinor: number, qty: number): number {
  if (qty === 0) return 0;
  const scaled = totalMinor * QTY_SCALE * COST_SCALE;
  if (!Number.isSafeInteger(scaled)) throw new ServiceError("AMOUNT_OUT_OF_RANGE");
  return roundHalfUp(scaled / qty);
}

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 * Largest-remainder method: floor every share, then hand the leftover
 * minor units to the lines with the biggest fractional parts.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (total < 0) throw new ServiceError("INVALID_ALLOCATION_TOTAL");
  if (weights.some((w) => w < 0)) throw new ServiceError("INVALID_ALLOCATION_WEIGHT");
  if (weights.length === 0) return [];

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const effective = totalWeight > 0 ? weights : weights.map(() => 1);
  const effectiveTotal = totalWeight > 0 ? totalWeight : weights.length;

  const exact = effective.map((w) => (total * w) / effectiveTotal);
  const out = exact.map((e) => Math.floor(e));
  let remainder = total - out.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remainder > 0; k++, remainder--) {
    out[order[k % order.length].i] += 1;
  }
  return out;
}

/** pct is hundredths of a percent: 15% => 1500 */
export function applyPct(minor: number, pctBasisPoints: number): number {
  return roundHalfUp((minor * pctBasisPoints) / 10_000);
}

import { allocate } from "@/lib/money";

/**
 * Percentage widths for the hero's splitting bar.
 *
 * The bar carries this page's whole argument: a 13-unit gap is not 13 units of
 * loss, it is 10 still being claimed and 3 actually lost. If the pieces do not
 * fill the bar exactly, the picture contradicts the sentence beside it — so
 * the split goes through `allocate`, the same largest-remainder helper the
 * money code uses to divide a shipment's freight across its lines. Thirds are
 * where a naive `Math.round` leaves the bar 1% short of its own container.
 *
 * Parts that cannot be drawn — zero, negative — are dropped rather than
 * rendered as a zero-width sliver or a NaN style.
 */
export function barSegments(parts: number[]): number[] {
  const drawable = parts.filter((p) => Number.isFinite(p) && p > 0);
  if (drawable.length === 0) return [];
  return allocate(100, drawable);
}

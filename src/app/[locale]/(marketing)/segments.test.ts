import { describe, it, expect } from "vitest";
import { barSegments } from "./segments";

/**
 * The widths behind the hero's splitting bar.
 *
 * The bar is the page's one argument made visual: a 13-unit gap is not 13
 * units of loss, it is 10 still being claimed and 3 actually lost. If the two
 * pieces do not add up to the whole bar, the picture contradicts the sentence
 * beside it — so the arithmetic is done here, where it can be checked, and
 * through the same `allocate` the money code already uses.
 */

describe("barSegments", () => {
  it("splits a whole into pieces that fill it exactly", () => {
    const parts = barSegments([10, 3]);

    expect(parts).toHaveLength(2);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
  });

  it("keeps the larger cause visibly larger", () => {
    const [claimed, lost] = barSegments([10, 3]);
    expect(claimed).toBeGreaterThan(lost!);
  });

  it("loses nothing to rounding on thirds", () => {
    // Three equal parts cannot each be an exact percentage. Largest remainder
    // is what stops the bar ending 1% short of its own container.
    const parts = barSegments([1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
  });

  it("gives a single cause the whole bar", () => {
    expect(barSegments([7])).toEqual([100]);
  });

  it("returns nothing for an empty split rather than dividing by zero", () => {
    expect(barSegments([])).toEqual([]);
  });

  it("returns nothing when every part is zero, instead of NaN widths", () => {
    // A reconciliation that explained everything has no gap to draw.
    expect(barSegments([0, 0])).toEqual([]);
  });

  it("ignores negative parts, which have no width to draw", () => {
    expect(barSegments([10, -3])).toEqual([100]);
  });
});

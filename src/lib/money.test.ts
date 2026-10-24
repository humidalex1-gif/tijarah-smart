import { describe, it, expect } from "vitest";
import {
  QTY_SCALE, COST_SCALE, toQty, fromQty, toMinor, fromMinor,
  toCost, fromCost, costOf, unitCostFrom, allocate, applyPct,
} from "@/lib/money";

describe("scaling helpers", () => {
  it("converts quantities to and from thousandths", () => {
    expect(toQty(5)).toBe(5000);
    expect(toQty("2.5")).toBe(2500);
    expect(toQty(0.001)).toBe(1);
    expect(fromQty(2500)).toBe(2.5);
    expect(QTY_SCALE).toBe(1000);
  });

  it("rounds quantities beyond three decimals", () => {
    expect(toQty(1.00049)).toBe(1000);
    expect(toQty(1.0005)).toBe(1001);
  });

  it("rounds negative quantities half away from zero", () => {
    // Math.round(-0.5) === -0, so this only passes with the bespoke negative branch.
    expect(toQty(-1.0005)).toBe(-1001);
    expect(toQty(-5)).toBe(-5000);
  });

  it("rejects non-numeric quantities", () => {
    expect(() => toQty("abc")).toThrow("INVALID_QUANTITY");
  });

  it("converts money to and from minor units", () => {
    expect(toMinor(12.34)).toBe(1234);
    expect(toMinor("0.05")).toBe(5);
    expect(fromMinor(1234)).toBe(12.34);
    expect(toMinor(12.345)).toBe(1235);
  });

  it("rounds negative amounts half away from zero", () => {
    expect(toMinor(-12.345)).toBe(-1235);
  });

  it("rejects non-numeric amounts", () => {
    expect(() => toMinor("abc")).toThrow("INVALID_AMOUNT");
  });

  it("scales unit costs by COST_SCALE", () => {
    expect(COST_SCALE).toBe(10_000);
    expect(toCost(1234)).toBe(12_340_000);
    expect(fromCost(12_340_000)).toBe(1234);
  });
});

describe("costOf", () => {
  it("multiplies scaled quantity by scaled unit cost into minor units", () => {
    // 3 units at 12.50 (1250 minor) => 37.50 => 3750 minor
    expect(costOf(toQty(3), toCost(1250))).toBe(3750);
  });

  it("handles fractional quantities", () => {
    // 2.5 kg at 4.00 (400 minor) => 10.00 => 1000 minor
    expect(costOf(toQty(2.5), toCost(400))).toBe(1000);
  });

  it("rounds to the nearest minor unit", () => {
    // 3 units at 0.3333 minor units => 0.9999 => rounds to 1
    expect(costOf(toQty(3), 3333)).toBe(1);
  });

  it("returns zero for zero quantity", () => {
    expect(costOf(0, toCost(999))).toBe(0);
  });

  it("throws instead of silently drifting at absurd magnitudes", () => {
    expect(() => costOf(toQty(Number.MAX_SAFE_INTEGER), toCost(999))).toThrow(
      "AMOUNT_OUT_OF_RANGE",
    );
  });
});

describe("unitCostFrom", () => {
  it("derives a scaled unit cost from a total and a quantity", () => {
    expect(unitCostFrom(3750, toQty(3))).toBe(toCost(1250));
  });

  it("keeps four decimal places of precision", () => {
    // 1000 minor over 3 units => 333.3333 minor per unit
    expect(unitCostFrom(1000, toQty(3))).toBe(3_333_333);
  });

  it("returns zero when quantity is zero", () => {
    expect(unitCostFrom(1000, 0)).toBe(0);
  });

  it("throws instead of silently drifting at absurd magnitudes", () => {
    expect(() => unitCostFrom(Number.MAX_SAFE_INTEGER, toQty(1))).toThrow(
      "AMOUNT_OUT_OF_RANGE",
    );
  });
});

describe("allocate", () => {
  it("splits exactly with no remainder", () => {
    expect(allocate(300, [1, 1, 1])).toEqual([100, 100, 100]);
  });

  it("distributes the remainder to the largest fractions first", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("always sums to the total", () => {
    const parts = allocate(1000, [7, 11, 3, 29]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("weights proportionally", () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });

  it("falls back to an equal split when all weights are zero", () => {
    expect(allocate(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it("returns an empty array for no lines", () => {
    expect(allocate(500, [])).toEqual([]);
  });

  it("returns zeros when the total is zero", () => {
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
  });

  it("rejects negative totals", () => {
    expect(() => allocate(-1, [1])).toThrow("INVALID_ALLOCATION_TOTAL");
  });

  it("rejects negative weights", () => {
    expect(() => allocate(10, [1, -1])).toThrow("INVALID_ALLOCATION_WEIGHT");
  });
});

describe("applyPct", () => {
  it("applies a percentage given in basis points of a percent", () => {
    // 15% of 2000 minor units
    expect(applyPct(2000, 1500)).toBe(300);
  });

  it("rounds half up", () => {
    expect(applyPct(1, 5000)).toBe(1); // 50% of 1 => 0.5 => 1
  });

  it("rounds negative amounts half away from zero", () => {
    expect(applyPct(-1, 5000)).toBe(-1); // 50% of -1 => -0.5 => -1
  });

  it("returns zero for a zero rate", () => {
    expect(applyPct(2000, 0)).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { niceStep, niceTicks } from "@/components/charts/LineChart";

describe("niceStep", () => {
  it("rounds up to the nearest 1/2/5 x 10^n", () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(15)).toBe(20);
    expect(niceStep(45)).toBe(50);
    expect(niceStep(80)).toBe(100);
  });
});

describe("niceTicks", () => {
  it("produces round tick values covering the data range", () => {
    const { min, max, values } = niceTicks(0, 12, 4);
    expect(min).toBe(0);
    expect(max).toBe(15);
    expect(values).toEqual([0, 5, 10, 15]);
  });

  it("covers negative and positive values symmetrically rounded outward", () => {
    const { min, max, values } = niceTicks(-16.4, 23.1, 4);
    // Regression case from the review: raw min/max interpolation used to
    // produce a label like "−SAR 16.4" — min/max here must land on round
    // step boundaries instead.
    expect(Math.abs(min % 10)).toBe(0);
    expect(Math.abs(max % 10)).toBe(0);
    expect(values.every((v) => Math.abs(v % 10) === 0)).toBe(true);
    expect(min).toBeLessThanOrEqual(-16.4);
    expect(max).toBeGreaterThanOrEqual(23.1);
  });

  it("pads a flat (all-equal) range instead of dividing by zero", () => {
    const { min, max, values } = niceTicks(0, 0, 4);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(min);
    expect(values.length).toBeGreaterThan(1);
  });
});

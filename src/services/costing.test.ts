import { describe, it, expect } from "vitest";
import { toQty, toCost, toMinor } from "@/lib/money";
import { newAverageCost, allocateCost, landedUnitCost } from "@/services/costing";

describe("newAverageCost", () => {
  it("uses the received cost when there is no existing stock", () => {
    expect(
      newAverageCost({
        oldQty: 0, oldAvgCost: 0,
        receivedQty: toQty(10), receivedUnitCost: toCost(1000),
      }),
    ).toBe(toCost(1000));
  });

  it("computes the weighted average of old and new stock", () => {
    // 10 @ 10.00 + 10 @ 20.00 => 15.00
    expect(
      newAverageCost({
        oldQty: toQty(10), oldAvgCost: toCost(1000),
        receivedQty: toQty(10), receivedUnitCost: toCost(2000),
      }),
    ).toBe(toCost(1500));
  });

  it("weights by quantity, not by line count", () => {
    // 30 @ 10.00 + 10 @ 20.00 => 12.50
    expect(
      newAverageCost({
        oldQty: toQty(30), oldAvgCost: toCost(1000),
        receivedQty: toQty(10), receivedUnitCost: toCost(2000),
      }),
    ).toBe(toCost(1250));
  });

  it("keeps four decimal places", () => {
    // 1 @ 10.00 + 2 @ 20.00 => 16.6667 (minor units: 1666.6667)
    const avg = newAverageCost({
      oldQty: toQty(1), oldAvgCost: toCost(1000),
      receivedQty: toQty(2), receivedUnitCost: toCost(2000),
    });
    expect(avg).toBe(16_666_667);
  });

  it("ignores a negative existing balance and adopts the received cost", () => {
    expect(
      newAverageCost({
        oldQty: toQty(-5), oldAvgCost: toCost(1000),
        receivedQty: toQty(10), receivedUnitCost: toCost(2000),
      }),
    ).toBe(toCost(2000));
  });

  it("keeps the old average when nothing is received", () => {
    expect(
      newAverageCost({
        oldQty: toQty(10), oldAvgCost: toCost(1000),
        receivedQty: 0, receivedUnitCost: toCost(9999),
      }),
    ).toBe(toCost(1000));
  });

  it("throws instead of silently drifting at absurd magnitudes", () => {
    expect(() =>
      newAverageCost({
        oldQty: toQty(Number.MAX_SAFE_INTEGER),
        oldAvgCost: toCost(1000),
        receivedQty: toQty(10),
        receivedUnitCost: toCost(2000),
      }),
    ).toThrow("AMOUNT_OUT_OF_RANGE");
  });

  // Nothing produces a negative unit cost today, but a credit-note adjustment
  // or a write-down would — and this is the one function whose output can never
  // be recomputed. InventoryMovement stores unitCost, but the average is only
  // ever the running result of every IN ever posted, so a value dragged down
  // silently stays wrong forever.
  it("refuses a negative received unit cost rather than dragging the average down", () => {
    expect(() =>
      newAverageCost({
        oldQty: toQty(10),
        oldAvgCost: toCost(toMinor(30)),
        receivedQty: toQty(5),
        receivedUnitCost: -1,
      }),
    ).toThrow("INVALID_UNIT_COST");
  });

  it("accepts a received unit cost of exactly zero", () => {
    // Free stock is a real thing — a supplier sample, a promotional unit. The
    // guard above must reject negatives without also rejecting zero.
    const avg = newAverageCost({
      oldQty: toQty(10),
      oldAvgCost: toCost(toMinor(30)),
      receivedQty: toQty(10),
      receivedUnitCost: 0,
    });
    expect(avg).toBe(toCost(toMinor(15)));
  });
});

describe("allocateCost", () => {
  const lines = [
    { quantity: toQty(10), lineValue: toMinor(100), weightGrams: 1000 },
    { quantity: toQty(30), lineValue: toMinor(300), weightGrams: 500 },
  ];

  it("allocates by quantity", () => {
    expect(allocateCost(toMinor(400), "QUANTITY", lines)).toEqual([
      toMinor(100), toMinor(300),
    ]);
  });

  it("allocates by line value", () => {
    expect(allocateCost(toMinor(400), "VALUE", lines)).toEqual([
      toMinor(100), toMinor(300),
    ]);
  });

  it("allocates by total weight (unit weight x quantity)", () => {
    // 10 x 1000g = 10kg, 30 x 500g = 15kg => 40% / 60%
    expect(allocateCost(toMinor(100), "WEIGHT", lines)).toEqual([
      toMinor(40), toMinor(60),
    ]);
  });

  it("allocates equally regardless of size", () => {
    expect(allocateCost(toMinor(100), "EQUAL", lines)).toEqual([
      toMinor(50), toMinor(50),
    ]);
  });

  it("refuses MANUAL until Stage 2 implements manual splits", () => {
    // Even with manualShare values supplied, MANUAL must throw: there is no
    // storage for splits yet, and a partial payload would silently degrade
    // to an equal split baked permanently into landed costs.
    const manual = [
      { ...lines[0], manualShare: 25 },
      { ...lines[1], manualShare: 75 },
    ];
    expect(() => allocateCost(toMinor(100), "MANUAL", manual)).toThrowError(
      expect.objectContaining({ code: "MANUAL_ALLOCATION_NOT_SUPPORTED" }),
    );
    expect(() => allocateCost(toMinor(100), "MANUAL", lines)).toThrowError(
      expect.objectContaining({ code: "MANUAL_ALLOCATION_NOT_SUPPORTED" }),
    );
  });

  it("never loses a minor unit to rounding", () => {
    const three = [
      { quantity: toQty(1), lineValue: toMinor(1), weightGrams: 1 },
      { quantity: toQty(1), lineValue: toMinor(1), weightGrams: 1 },
      { quantity: toQty(1), lineValue: toMinor(1), weightGrams: 1 },
    ];
    const parts = allocateCost(100, "VALUE", three);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("returns zeros when there is no additional cost", () => {
    expect(allocateCost(0, "VALUE", lines)).toEqual([0, 0]);
  });

  it("rejects an allocation method it doesn't recognize instead of defaulting to EQUAL", () => {
    expect(() =>
      allocateCost(toMinor(100), "BOGUS" as unknown as "VALUE", lines),
    ).toThrow("INVALID_ALLOCATION_METHOD");
  });
});

describe("landedUnitCost", () => {
  it("adds the allocated cost to the base line cost and divides by quantity", () => {
    // base 1000.00 + allocated 200.00 over 10 units => 120.00 each
    expect(landedUnitCost(toMinor(1000), toMinor(200), toQty(10))).toBe(toCost(toMinor(120)));
  });

  it("returns zero when the quantity is zero", () => {
    expect(landedUnitCost(toMinor(1000), toMinor(200), 0)).toBe(0);
  });
});

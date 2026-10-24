import { describe, it, expect } from "vitest";
import { compareCosts, type OurProduct, type SallaProduct } from "./costCompare";
import { toCost, toMinor } from "@/lib/money";

/**
 * The comparison is deliberately PURE and separate from the HTTP layer.
 *
 * Its whole job is to answer one question the owner has been unable to answer
 * for two weeks: does Salla hold a cost for the three products whose zero cost
 * puts 45% of revenue on the books at 100% margin? A wrong answer here would
 * send a wrong figure into `fix-product-costs.ts`, which has no undo — so this
 * refuses to guess in every direction it can be asked to.
 */

const ours = (over: Partial<OurProduct> = {}): OurProduct => ({
  sku: "bowl-large-016",
  nameAr: "وعاء كبير",
  nameEn: "Large bowl",
  avgCost: 0,
  sold: true,
  ...over,
});

const theirs = (over: Partial<SallaProduct> = {}): SallaProduct => ({
  sku: "bowl-large-016",
  name: "وعاء كبير",
  costMinor: toMinor(12.3),
  ...over,
});

describe("compareCosts", () => {
  it("names the products a Salla cost would actually repair", () => {
    const result = compareCosts([ours()], [theirs()]);

    // The headline the owner is waiting for: this SKU is booked at 100% margin
    // and Salla holds the number that fixes it.
    expect(result.repairable.map((r) => r.sku)).toEqual(["bowl-large-016"]);
    expect(result.repairable[0]!.sallaCostMinor).toBe(1230);
  });

  it("does not offer to repair a product that already carries a cost", () => {
    const result = compareCosts([ours({ avgCost: toCost(toMinor(9.5)) })], [theirs()]);

    // `newAverageCost` moves avgCost only through IN movements. Overwriting a
    // real weighted average with a catalogue figure would destroy history.
    expect(result.repairable).toHaveLength(0);
    expect(result.rows[0]!.status).toBe("ALREADY_COSTED");
  });

  it("reports a zero-cost product whose Salla cost is empty, rather than treating empty as zero", () => {
    const result = compareCosts([ours()], [theirs({ costMinor: null })]);

    expect(result.repairable).toHaveLength(0);
    expect(result.rows[0]!.status).toBe("SALLA_HAS_NO_COST");
  });

  it("treats a Salla cost of exactly zero as no cost at all", () => {
    // An unfilled field and a field filled with 0 are indistinguishable in
    // meaning here, and writing 0 as a cost is what caused the problem.
    const result = compareCosts([ours()], [theirs({ costMinor: 0 })]);

    expect(result.repairable).toHaveLength(0);
    expect(result.rows[0]!.status).toBe("SALLA_HAS_NO_COST");
  });

  it("never repairs a product that has not been sold, and says why", () => {
    // Unsold zero-cost products understate inventory value only; no booked
    // profit depends on them, so they are not urgent and not silently bundled.
    const result = compareCosts([ours({ sold: false })], [theirs()]);

    expect(result.repairable).toHaveLength(0);
    expect(result.rows[0]!.status).toBe("UNSOLD_COST_AVAILABLE");
  });

  it("lists our products Salla does not carry, and Salla products we do not", () => {
    const result = compareCosts(
      [ours({ sku: "only-ours" })],
      [theirs({ sku: "only-theirs" })],
    );

    expect(result.rows.find((r) => r.sku === "only-ours")!.status).toBe("NOT_IN_SALLA");
    expect(result.unmatchedSalla).toEqual(["only-theirs"]);
  });

  it("matches SKUs case-insensitively and ignores surrounding spaces", () => {
    // Salla's SKU is typed by a human in a web form; ours came from Fast Hub.
    const result = compareCosts([ours({ sku: "Pets-large-005" })], [theirs({ sku: " pets-large-005 " })]);

    expect(result.repairable.map((r) => r.sku)).toEqual(["Pets-large-005"]);
  });

  it("refuses a duplicate Salla SKU instead of silently picking one", () => {
    // Two rows claiming the same SKU cannot both be the cost, and choosing by
    // array order would be arbitrary and invisible.
    const result = compareCosts(
      [ours()],
      [theirs({ costMinor: toMinor(12.3) }), theirs({ costMinor: toMinor(44.0) })],
    );

    expect(result.rows[0]!.status).toBe("AMBIGUOUS_IN_SALLA");
    expect(result.repairable).toHaveLength(0);
  });

  it("summarises what was seen, so an empty result is distinguishable from a failed read", () => {
    const result = compareCosts([ours(), ours({ sku: "x", sold: false })], [theirs()]);

    expect(result.summary).toEqual({
      ourProducts: 2,
      sallaProducts: 1,
      matched: 1,
      sallaCostsPresent: 1,
      repairable: 1,
    });
  });

  it("holds the cost in minor units and converts to the cost scale only on request", () => {
    // Rule 5: money is minor units, unit costs are minor x10 000. Mixing the
    // two is how a cost lands 100x wrong, and `fix-product-costs` takes SAR.
    const result = compareCosts([ours()], [theirs({ costMinor: toMinor(85.45) })]);
    const row = result.repairable[0]!;

    expect(row.sallaCostMinor).toBe(8545);
    expect(row.sallaCostSar).toBe("85.45");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The composition itself: that the two sides reach `compareCosts` the right
 * way round. Swapping them would report every one of our products as absent
 * from Salla and every Salla product as unmatched — a plausible-looking
 * screen that is entirely wrong.
 */

const listSallaProducts = vi.hoisted(() => vi.fn());
const loadOurCosts = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ listSallaProducts }));
vi.mock("./ourCosts", () => ({ loadOurCosts }));

const { buildSallaCostReport } = await import("./costReport");

beforeEach(() => {
  listSallaProducts.mockReset();
  loadOurCosts.mockReset();
});

describe("buildSallaCostReport", () => {
  it("puts our products and Salla's on the correct sides of the comparison", async () => {
    loadOurCosts.mockResolvedValue([
      { sku: "bowl-large-016", nameAr: "وعاء كبير", nameEn: "Large bowl", avgCost: 0, sold: true },
    ]);
    listSallaProducts.mockResolvedValue([
      { sku: "bowl-large-016", name: "وعاء كبير", costMinor: 1230 },
    ]);

    const report = await buildSallaCostReport("c1");

    expect(report.repairable.map((r) => r.sku)).toEqual(["bowl-large-016"]);
    expect(report.summary.matched).toBe(1);
  });

  it("does not query our books when Salla refuses", async () => {
    listSallaProducts.mockRejectedValue(new Error("SALLA_NOT_CONNECTED"));

    await expect(buildSallaCostReport("c1")).rejects.toThrow("SALLA_NOT_CONNECTED");
    // Reading our own costs to accompany an error the screen will discard is
    // work nobody sees.
    expect(loadOurCosts).not.toHaveBeenCalled();
  });

  it("reports an empty Salla catalogue as empty rather than as a match", async () => {
    loadOurCosts.mockResolvedValue([
      { sku: "a", nameAr: "أ", nameEn: "A", avgCost: 0, sold: true },
    ]);
    listSallaProducts.mockResolvedValue([]);

    const report = await buildSallaCostReport("c1");

    expect(report.repairable).toHaveLength(0);
    expect(report.rows[0]!.status).toBe("NOT_IN_SALLA");
    expect(report.summary.sallaProducts).toBe(0);
  });
});

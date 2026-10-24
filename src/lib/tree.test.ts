import { describe, it, expect } from "vitest";
import { collectSubtreeIds, wouldCreateCycle } from "@/lib/tree";

// Beverages -> Soft drinks -> Cola, and Beverages -> Juice. Plus an unrelated
// root so every test proves the walk stops at the subtree rather than
// returning everything it was handed.
const NODES = [
  { id: "bev", parentId: null },
  { id: "soft", parentId: "bev" },
  { id: "cola", parentId: "soft" },
  { id: "juice", parentId: "bev" },
  { id: "snacks", parentId: null },
  { id: "crisps", parentId: "snacks" },
];

describe("collectSubtreeIds", () => {
  it("includes the root and every descendant, at any depth", () => {
    expect(collectSubtreeIds(NODES, "bev").sort()).toEqual(["bev", "cola", "juice", "soft"]);
  });

  it("stops at the subtree instead of returning unrelated branches", () => {
    expect(collectSubtreeIds(NODES, "soft").sort()).toEqual(["cola", "soft"]);
    expect(collectSubtreeIds(NODES, "bev")).not.toContain("snacks");
  });

  it("returns just the root for a leaf", () => {
    expect(collectSubtreeIds(NODES, "cola")).toEqual(["cola"]);
  });

  it("returns nothing for an id that is not in the set", () => {
    // An id from another company, or a stale one, must resolve to nothing
    // rather than to everything — callers feed this straight into a `where`.
    expect(collectSubtreeIds(NODES, "other-company-category")).toEqual([]);
  });

  it("terminates on a cyclic parent chain rather than looping forever", () => {
    // Unreachable through the app today (nothing reparents a node), but Stage
    // 2B adds a reparent, and a walk that hangs on bad data is a worse
    // failure than one that stops early.
    const cyclic = [
      { id: "a", parentId: "c" },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
    ];
    expect(collectSubtreeIds(cyclic, "a").sort()).toEqual(["a", "b", "c"]);
  });
});

describe("wouldCreateCycle", () => {
  it("refuses a node becoming its own parent", () => {
    expect(wouldCreateCycle(NODES, "bev", "bev")).toBe(true);
  });

  it("refuses a node being reparented under its own descendant", () => {
    expect(wouldCreateCycle(NODES, "bev", "cola")).toBe(true);
  });

  it("allows a move to an unrelated branch", () => {
    expect(wouldCreateCycle(NODES, "soft", "snacks")).toBe(false);
  });

  it("allows a move to the top level", () => {
    expect(wouldCreateCycle(NODES, "cola", null)).toBe(false);
  });
});

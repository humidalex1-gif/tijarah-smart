import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action()
// re-reads Membership, so the test controls that read.
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/stockCount", () => ({
  createStockCount: vi.fn(async () => ({ sessionId: "s1", countNumber: "CNT-0001", lineCount: 3 })),
  recordCount: vi.fn(async () => ({ lineId: "l1" })),
  requestRecount: vi.fn(async () => ({ lineId: "l1" })),
  submitForReview: vi.fn(async () => ({ sessionId: "s1", countedLines: 1, uncountedLines: 0 })),
  postStockCount: vi.fn(async () => ({ sessionId: "s1", linesPosted: 1, linesSkipped: 0, movementsCreated: 1 })),
  cancelStockCount: vi.fn(async () => ({ sessionId: "s1" })),
}));

const actions = await import("./actions");
const { prisma } = await import("@/lib/db");
const svc = await import("@/services/stockCount");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

describe("stock count action gates", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.clearAllMocks();
  });

  it("lets a sales employee record a count", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await actions.recordCountAction(form({ lineId: "l1", countedQty: "8" }));

    expect(result.ok).toBe(true);
    expect(svc.recordCount).toHaveBeenCalled();
  });

  it("refuses a sales employee posting the variance", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await actions.postStockCountAction(form({ sessionId: "s1" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.postStockCount).not.toHaveBeenCalled();
  });

  it("refuses a viewer counting at all", async () => {
    mockRole("VIEWER");

    const result = await actions.recordCountAction(form({ lineId: "l1", countedQty: "8" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.recordCount).not.toHaveBeenCalled();
  });

  it("refuses a sales employee cancelling a session", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await actions.cancelStockCountAction(form({ sessionId: "s1", reason: "x" }));

    expect(result.ok).toBe(false);
    expect(svc.cancelStockCount).not.toHaveBeenCalled();
  });

  it("converts the counted quantity to thousandths before calling the service", async () => {
    await actions.recordCountAction(form({ lineId: "l1", countedQty: "8" }));

    expect(svc.recordCount).toHaveBeenCalledWith(
      expect.anything(),
      { lineId: "l1", countedQty: 8000 },
    );
  });

  it("refuses a sales employee requesting a recount (reviewer-only)", async () => {
    // requestRecountAction is gated on inventory.count_post, not
    // inventory.count — requesting a recount is a reviewer's decision made
    // from the review screen, which a counter (inventory.count only) cannot
    // even see (spec §8).
    mockRole("SALES_EMPLOYEE");

    const result = await actions.requestRecountAction(form({ lineId: "l1" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.requestRecount).not.toHaveBeenCalled();
  });

  it("lets a warehouse manager request a recount", async () => {
    mockRole("WAREHOUSE_MANAGER");

    const result = await actions.requestRecountAction(form({ lineId: "l1" }));

    expect(result.ok).toBe(true);
    expect(svc.requestRecount).toHaveBeenCalledWith(expect.anything(), { lineId: "l1" });
  });

  it("creates a WAREHOUSE-scope stock count", async () => {
    const result = await actions.createStockCountAction(form({
      warehouseId: "w1", scopeType: "WAREHOUSE",
    }));

    expect(result.ok).toBe(true);
    expect(svc.createStockCount).toHaveBeenCalledWith(expect.anything(), {
      warehouseId: "w1",
      scope: { scopeType: "WAREHOUSE" },
      notes: undefined,
    });
  });

  it("creates a MANUAL-scope stock count by decoding the productIds JSON field", async () => {
    const result = await actions.createStockCountAction(form({
      warehouseId: "w1", scopeType: "MANUAL", productIds: JSON.stringify(["p1", "p2"]),
    }));

    expect(result.ok).toBe(true);
    expect(svc.createStockCount).toHaveBeenCalledWith(expect.anything(), {
      warehouseId: "w1",
      scope: { scopeType: "MANUAL", productIds: ["p1", "p2"] },
      notes: undefined,
    });
  });

  it("rejects a corrupt productIds payload with a specific, translatable field error instead of errors.generic", async () => {
    // Regression guard for the resolved risk: a bare JSON.parse on
    // productIds would let a malformed value throw a raw SyntaxError that
    // action()'s catch-all turns into errors.generic, telling the merchant
    // nothing about what went wrong. Parsing inside the schema (ctx.addIssue)
    // must attach a real dictionary key to the productIds field instead,
    // matching jsonLines() in sales/actions.ts and purchases/actions.ts.
    const result = await actions.createStockCountAction(form({
      warehouseId: "w1", scopeType: "MANUAL", productIds: "not json",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION");
      expect(result.fields?.productIds).toBe("errors.INVALID_LINES");
    }
    expect(svc.createStockCount).not.toHaveBeenCalled();
  });

  it("submits a session for review", async () => {
    const result = await actions.submitForReviewAction(form({ sessionId: "s1" }));

    expect(result.ok).toBe(true);
    expect(svc.submitForReview).toHaveBeenCalledWith(expect.anything(), { sessionId: "s1" });
  });

  it("refuses a viewer submitting a session for review", async () => {
    // Gated on inventory.count, same as createStockCountAction below. VIEWER
    // holds neither inventory.count nor inventory.count_post, so it's the
    // role that discriminates — every fixed role that holds count_post
    // (WAREHOUSE_MANAGER, "*") also holds count, so none of those isolate
    // this specific permission the way SALES_EMPLOYEE isolates count_post
    // elsewhere in this file.
    mockRole("VIEWER");

    const result = await actions.submitForReviewAction(form({ sessionId: "s1" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.submitForReview).not.toHaveBeenCalled();
  });

  it("refuses a viewer creating a stock count", async () => {
    // Same gate (inventory.count) and same discriminating role as
    // submitForReviewAction above.
    mockRole("VIEWER");

    const result = await actions.createStockCountAction(form({
      warehouseId: "w1", scopeType: "WAREHOUSE",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.createStockCount).not.toHaveBeenCalled();
  });

  it("lets a warehouse manager post a count", async () => {
    mockRole("WAREHOUSE_MANAGER");

    const result = await actions.postStockCountAction(form({ sessionId: "s1" }));

    expect(result.ok).toBe(true);
    expect(svc.postStockCount).toHaveBeenCalledWith(expect.anything(), { sessionId: "s1" });
  });
});

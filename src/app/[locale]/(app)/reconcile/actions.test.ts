import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action()
// re-reads Membership, so the test controls that read.
vi.mock("@/lib/db", () => ({
  prisma: {
    membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) },
    warehouse: { findFirstOrThrow: vi.fn(async () => ({ id: "w1", code: "01" })) },
  },
}));
vi.mock("@/services/fasthub/poll", () => ({
  syncFastHubInventory: vi.fn(async () => ({
    lines: [{
      productId: "p1", sku: "very-large",
      sellable: 14000, onHand: 16000, booksAvailable: 14000, difference: 0,
    }],
    unknownSkus: ["ghost-sku"],
  })),
}));
vi.mock("@/services/reconcile", () => ({
  postReconcile: vi.fn(async () => ({
    settledClaims: 0, shrinkagePosted: 0, skipped: 0, isPhysicalCount: true,
  })),
  previewReconcile: vi.fn(async () => ([{
    productId: "p1", variantId: null,
    expectedSellable: 40000, expectedDamaged: 0,
    assertedSellable: 37000, assertedDamaged: null,
    gap: 3000, settleableSellable: 2000, settleableDamaged: 0,
    stillClaimed: 1000, unexplained: 0, surplus: 0,
    damagedDelta: 0, damagedReturns: 0, damagedFromShelf: 0,
  }])),
}));

const actions = await import("./actions");
const { prisma } = await import("@/lib/db");
const svc = await import("@/services/reconcile");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

const validForm = () =>
  form({
    warehouseId: "w1",
    asOf: "2026-07-31",
    isPhysicalCount: "on",
    lines: JSON.stringify([{ productId: "p1", sellable: 37000 }]),
  });

describe("postReconcileAction gate", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.clearAllMocks();
  });

  it("lets a warehouse manager post a reconciliation", async () => {
    mockRole("WAREHOUSE_MANAGER");

    const result = await actions.postReconcileAction(validForm());

    expect(result.ok).toBe(true);
    expect(svc.postReconcile).toHaveBeenCalled();
  });

  it("refuses a sales employee, without calling the service", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await actions.postReconcileAction(validForm());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.postReconcile).not.toHaveBeenCalled();
  });

  it("refuses an accountant, without calling the service", async () => {
    // Posting a reconciliation moves inventory, which this role cannot do
    // anywhere else in the application.
    mockRole("ACCOUNTANT");

    const result = await actions.postReconcileAction(validForm());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.postReconcile).not.toHaveBeenCalled();
  });

  it("refuses a viewer, without calling the service", async () => {
    mockRole("VIEWER");

    const result = await actions.postReconcileAction(validForm());

    expect(result.ok).toBe(false);
    expect(svc.postReconcile).not.toHaveBeenCalled();
  });

  it("treats an absent checkbox as NOT a physical count", async () => {
    // An unticked HTML checkbox submits nothing at all. Reading absence as
    // "physical count" would suppress the caveat the profit screen shows on
    // shrinkage that came from the warehouse's own system.
    mockRole("OWNER");

    const fd = form({
      warehouseId: "w1",
      asOf: "2026-07-31",
      lines: JSON.stringify([{ productId: "p1", sellable: 37000 }]),
    });
    const result = await actions.postReconcileAction(fd);

    expect(result.ok).toBe(true);
    expect(svc.postReconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isPhysicalCount: false }),
    );
  });

  it("attaches a real dictionary key to the field for a malformed lines payload", async () => {
    // action() always returns errors.generic at the TOP level for a validation
    // failure and puts the per-field message in `fields`. So the point of
    // parsing inside the schema with ctx.addIssue is that `fields.lines`
    // carries a translatable key — a bare JSON.parse would throw a
    // SyntaxError, be caught by the handler's catch-all, and leave the
    // merchant with nothing but the generic message and no field named.
    mockRole("OWNER");

    const fd = form({
      warehouseId: "w1", asOf: "2026-07-31", isPhysicalCount: "on", lines: "{not json",
    });
    const result = await actions.postReconcileAction(fd);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION");
      expect(result.fields?.lines).toBe("errors.INVALID_LINES");
    }
    expect(svc.postReconcile).not.toHaveBeenCalled();
  });

  it("rejects an empty lines array", async () => {
    mockRole("OWNER");

    const fd = form({
      warehouseId: "w1", asOf: "2026-07-31", isPhysicalCount: "on", lines: "[]",
    });
    const result = await actions.postReconcileAction(fd);

    expect(result.ok).toBe(false);
    expect(svc.postReconcile).not.toHaveBeenCalled();
  });
});

/**
 * The decomposition into settleable / still-claimed / unexplained is the entire
 * product of the reconcile screen, and until now it came back only AFTER the
 * post — which is irreversible. `previewReconcile` was built, tested and
 * translated ("راجع الأرقام" / "Check figures") and then wired to nothing.
 */
describe("previewReconcileAction", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.clearAllMocks();
  });

  it("returns the decomposition without posting anything", async () => {
    const fd = form({
      warehouseId: "w1",
      asOf: "2026-07-31",
      lines: JSON.stringify([{ productId: "p1", sellable: 37000 }]),
    });

    const result = await actions.previewReconcileAction(fd);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0].unexplained).toBe(0);
    expect(svc.previewReconcile).toHaveBeenCalled();
    // The whole point: looking must never write.
    expect(svc.postReconcile).not.toHaveBeenCalled();
  });

  it("needs no isPhysicalCount, because looking is not counting", async () => {
    const fd = form({
      warehouseId: "w1",
      asOf: "2026-07-31",
      lines: JSON.stringify([{ productId: "p1", sellable: 37000 }]),
    });

    const result = await actions.previewReconcileAction(fd);

    expect(result.ok).toBe(true);
    expect(svc.previewReconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ isPhysicalCount: expect.anything() }),
    );
  });

  it("refuses a viewer, without calling the service", async () => {
    // A preview reads stock levels and claim positions. It is gated exactly as
    // the post is: a role that may not reconcile may not rehearse it either.
    mockRole("VIEWER");

    const fd = form({
      warehouseId: "w1",
      asOf: "2026-07-31",
      lines: JSON.stringify([{ productId: "p1", sellable: 37000 }]),
    });
    const result = await actions.previewReconcileAction(fd);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.previewReconcile).not.toHaveBeenCalled();
  });
});

/**
 * The owner reads Fast Hub's per-SKU figure on the sync screen and retypes it
 * here. The plan called for a "من فاست هب" button and it was never built.
 *
 * It fetches and RETURNS; it never writes. `syncFastHubInventory` is itself
 * write-free by design — mirroring their numbers into our balances would erase
 * the discrepancy the project exists to expose.
 */
describe("fastHubFiguresAction", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.clearAllMocks();
  });

  it("returns Fast Hub's sellable and on-hand per product", async () => {
    const result = await actions.fastHubFiguresAction(form({ warehouseId: "w1" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.lines[0]).toMatchObject({
        productId: "p1", sellable: 14000, onHand: 16000,
      });
      // Named, not swallowed: a SKU Fast Hub holds that we do not stock is the
      // owner's problem to see, exactly as the sync reports it.
      expect(result.data.unknownSkus).toEqual(["ghost-sku"]);
    }
  });

  it("posts nothing", async () => {
    await actions.fastHubFiguresAction(form({ warehouseId: "w1" }));

    expect(svc.postReconcile).not.toHaveBeenCalled();
    expect(svc.previewReconcile).not.toHaveBeenCalled();
  });

  it("refuses a viewer, without calling Fast Hub", async () => {
    mockRole("VIEWER");
    const poll = await import("@/services/fasthub/poll");

    const result = await actions.fastHubFiguresAction(form({ warehouseId: "w1" }));

    expect(result.ok).toBe(false);
    expect(poll.syncFastHubInventory).not.toHaveBeenCalled();
  });
});

/**
 * decisions.md #9: a bare `Error("CODE")` is not classified by `action()`, so
 * its code never reaches the client and `errorCatalog.test.ts` cannot see it —
 * its scan pattern matches only `new ServiceError` and `invalidState`. Stage 1B
 * retired that pattern at three sites; this feature reintroduced it at a fourth
 * and an adversarial review caught it.
 *
 * The fix is the idiom `action()` itself documents: findFirstOrThrow with the
 * tenant filter, whose P2025 maps to the catalogued `errors.NOT_FOUND`.
 */
describe("fastHubFiguresAction tenant gate", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.clearAllMocks();
  });

  it("names a vanished or foreign warehouse instead of falling to the generic", async () => {
    const { Prisma } = await import("@prisma/client");
    vi.mocked(prisma.warehouse.findFirstOrThrow).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("No record was found", {
        code: "P2025",
        clientVersion: "7.9.1",
      }),
    );

    const result = await actions.fastHubFiguresAction(form({ warehouseId: "w-other-company" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND");
      expect(result.error).toBe("errors.NOT_FOUND");
    }
  });

  it("scopes the warehouse read to the caller's company", async () => {
    await actions.fastHubFiguresAction(form({ warehouseId: "w1" }));

    expect(prisma.warehouse.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "w1", companyId: "c1" }),
      }),
    );
  });
});

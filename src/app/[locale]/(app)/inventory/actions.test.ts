import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action() re-reads
// Membership, so the test has to control that read (same pattern as
// src/lib/action.test.ts).
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/stock", () => ({
  receiveStockManual: vi.fn(),
  issueStock: vi.fn(),
  adjustStock: vi.fn(),
  createTransfer: vi.fn(async () => ({ transferId: "trf-1", transferNumber: "TRF-1" })),
  receiveTransfer: vi.fn(async () => undefined),
}));
vi.mock("@/services/reporting", () => ({ availableFor: vi.fn() }));

const { createTransferAction, fetchAvailability } = await import("./actions");
const { requireSession } = await import("@/lib/auth");
const { prisma } = await import("@/lib/db");
const { createTransfer } = await import("@/services/stock");
const { availableFor } = await import("@/services/reporting");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

describe("createTransferAction linesJson decoding", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue(session);
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(createTransfer).mockClear();
  });

  it("rejects a corrupt linesJson payload with a specific, translatable field error", async () => {
    // Regression guard: this used to fall back to the bare "errors.generic"
    // key with no field attached — indistinguishable from any other
    // unexpected failure. jsonLines() (src/app/.../inventory/actions.ts)
    // now attaches a dedicated dictionary key to the `linesJson` field.
    const result = await createTransferAction(form({
      sourceWarehouseId: "wh-1", destinationWarehouseId: "wh-2", linesJson: "not json",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION");
      expect(result.fields?.linesJson).toBe("errors.INVALID_LINES");
    }
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("rejects more than 200 lines with a specific, translatable field error", async () => {
    const lines = Array.from({ length: 201 }, (_, i) => ({ productId: `p-${i}`, quantity: 1 }));
    const result = await createTransferAction(form({
      sourceWarehouseId: "wh-1", destinationWarehouseId: "wh-2", linesJson: JSON.stringify(lines),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION");
      expect(result.fields?.linesJson).toBe("errors.TOO_MANY_LINES");
    }
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("accepts exactly 200 lines", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ productId: `p-${i}`, quantity: 1 }));
    const result = await createTransferAction(form({
      sourceWarehouseId: "wh-1", destinationWarehouseId: "wh-2", linesJson: JSON.stringify(lines),
    }));

    expect(result.ok).toBe(true);
    expect(createTransfer).toHaveBeenCalled();
  });
});

// fetchAvailability used to call can(session.role, ...) directly off the
// JWT — a display cache that survives a demotion or deactivation until the
// token dies (docs/decisions.md #2) — instead of re-reading Membership like
// action() does. It now uses the same five lines: re-read Membership,
// validate the role string against ROLES, then can() off that row.
describe("fetchAvailability authorization", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue(session);
    vi.mocked(availableFor).mockClear();
    vi.mocked(availableFor).mockResolvedValue(42);
  });

  it("returns 0 for a role whose membership is no longer ACTIVE, even though the JWT still says OWNER", async () => {
    // A DEACTIVATED membership: the findFirst `status: "ACTIVE"` filter
    // means this resolves to null, exactly like action()'s own guard.
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null as never);

    const result = await fetchAvailability("wh-1", "p-1");

    expect(result).toBe(0);
    expect(availableFor).not.toHaveBeenCalled();
  });

  it("returns 0 when the membership's role string is not a recognized Role", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "SUPERUSER" } as never);

    const result = await fetchAvailability("wh-1", "p-1");

    expect(result).toBe(0);
    expect(availableFor).not.toHaveBeenCalled();
  });

  it("returns the live availability for an ACTIVE membership holding inventory.view", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "VIEWER" } as never);

    const result = await fetchAvailability("wh-1", "p-1");

    expect(result).toBe(42);
    expect(availableFor).toHaveBeenCalledWith("c1", "wh-1", "p-1");
  });
});

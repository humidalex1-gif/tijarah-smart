import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — the helper
// re-reads Membership, so the test has to control that read.
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));

const { action } = await import("@/lib/action");
const { requireSession } = await import("@/lib/auth");
const { prisma } = await import("@/lib/db");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

describe("action helper", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue(session);
    // Cast: the mock factory only needs `role`, but TS types this dynamic
    // import against the real Prisma-backed module, which expects the full
    // Membership row.
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);
  });

  it("parses input, runs the handler, and returns the result", async () => {
    const run = action({
      permission: "products.create",
      schema: z.object({ name: z.string().min(1) }),
      handler: async (input, ctx) => ({ echoed: input.name, company: ctx.companyId }),
    });

    const result = await run(form({ name: "Widget" }));
    expect(result).toEqual({ ok: true, data: { echoed: "Widget", company: "c1" } });
  });

  it("returns field errors when validation fails", async () => {
    const run = action({
      permission: "products.create",
      schema: z.object({ name: z.string().min(1, "required") }),
      handler: async () => ({ never: true }),
    });

    const result = await run(form({ name: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields?.name).toBeDefined();
  });

  it("refuses when the membership's role lacks the permission, even if the token says OWNER", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "VIEWER" } as never);

    const run = action({
      permission: "sales.create",
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it("requires every permission in an array (AND, not OR)", async () => {
    // SALES_EMPLOYEE holds payments.create but not finance.manage_accounts —
    // regression guard for the multi-permission gate finance/actions.ts
    // relies on to keep a standalone payment page from granting a broader
    // capability than its single most-obvious permission implies.
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "SALES_EMPLOYEE" } as never);

    const run = action({
      permission: ["payments.create", "finance.manage_accounts"],
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it("passes when the role holds every permission in the array", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);

    const run = action({
      permission: ["payments.create", "finance.manage_accounts"],
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const result = await run(form({}));
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it("refuses an empty permission array instead of authorizing unconditionally", async () => {
    // A `for` loop over an empty array never calls assertCan — without an
    // explicit guard, `permission: []` would let ANY authenticated role
    // through, silently. Even though no caller constructs one today, the
    // type (`Permission | Permission[]`) permits it.
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);

    const run = action({
      permission: [],
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it("refuses when the membership is gone or no longer ACTIVE", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null);

    const run = action({
      permission: "products.view",
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it("refuses when the membership's role isn't a recognized Role", async () => {
    // Exercises the ROLES.includes() guard directly — a row with a role
    // string outside the enum (bad data, a stale migration, a partial write)
    // must never reach assertCan()/can(), which would map it to zero
    // permissions silently rather than fail loudly.
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "GHOST" } as never);

    const run = action({
      permission: "products.view",
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it("maps a Prisma P2025 tenant-check miss to NOT_FOUND", async () => {
    const { Prisma } = await import("@prisma/client");
    const run = action({
      permission: "sales.create",
      schema: z.object({}),
      handler: async () => {
        throw new Prisma.PrismaClientKnownRequestError("No record was found", {
          code: "P2025",
          clientVersion: "7",
        });
      },
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND");
      expect(result.error).toBe("errors.NOT_FOUND");
    }
  });

  it.each([
    "AMOUNT_OUT_OF_RANGE",
    "INVALID_AMOUNT",
    "INVALID_QUANTITY",
    "INVALID_ALLOCATION_TOTAL",
    "INVALID_ALLOCATION_WEIGHT",
  ])("maps a ServiceError %s from lib/money.ts's overflow/input guards to its own code", async (code) => {
    // These five codes used to arrive as bare `Error`s (decisions.md #9),
    // classified by action()'s now-removed BARE_CODES special case. They are
    // ServiceError like everything else now (src/lib/money.ts,
    // src/services/costing.ts), so this only exercises the same
    // `instanceof ServiceError` branch the test below does — kept as its
    // own case so a future regression that reintroduces a bare `Error` for
    // one of these specific codes fails loudly here.
    const { ServiceError } = await import("@/services/errors");
    const run = action({
      permission: "sales.create",
      schema: z.object({}),
      handler: async () => {
        throw new ServiceError(code);
      },
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("turns a ServiceError into its code and message key, without forwarding `details` to the client", async () => {
    const { ServiceError } = await import("@/services/errors");
    const run = action({
      permission: "sales.create",
      schema: z.object({}),
      handler: async () => {
        // `details` can carry server-internal data (row ids, raw counts,
        // other tenants' identifiers in a multi-tenant bug) — action() must
        // never forward it to the client, only the bare code.
        throw new ServiceError("INSUFFICIENT_STOCK", { available: 2, warehouseId: "wh-secret" });
      },
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INSUFFICIENT_STOCK");
      expect(result.error).toBe("errors.INSUFFICIENT_STOCK");
      // The full result must be exactly the two fields action() is
      // documented to return on a ServiceError — no `details`, no other
      // leaked property, under any key.
      expect(result).toEqual({ ok: false, error: "errors.INSUFFICIENT_STOCK", code: "INSUFFICIENT_STOCK" });
      expect(JSON.stringify(result)).not.toContain("wh-secret");
    }
  });

  it("collapses a repeated FormData field into an array while a single field stays a scalar", async () => {
    // Object.fromEntries(formData.entries()) used to silently keep only the
    // LAST value for a repeated key — this is the regression guard for that:
    // a field posted twice under the same name must reach the handler as an
    // array, and a field posted once must still be a plain scalar so every
    // existing single-valued schema in the app keeps working unchanged.
    const run = action({
      permission: "products.create",
      schema: z.object({
        single: z.string(),
        multi: z.union([z.string(), z.array(z.string())]),
      }),
      handler: async (input) => input,
    });

    const fd = new FormData();
    fd.append("single", "only-one");
    fd.append("multi", "a");
    fd.append("multi", "b");

    const result = await run(fd);
    expect(result).toEqual({
      ok: true,
      data: { single: "only-one", multi: ["a", "b"] },
    });
  });

  it("reports an unexpected error generically, without leaking the underlying message or a field", async () => {
    const run = action({
      permission: "sales.create",
      schema: z.object({}),
      handler: async () => {
        throw new Error("database on fire, connection string: postgres://user:pw@host/db");
      },
    });

    const result = await run(form({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The full result is exactly the generic shape — nothing from the
      // real error (message, stack, a `fields` entry) rides along with it.
      expect(result).toEqual({ ok: false, error: "errors.generic", code: "UNEXPECTED" });
    }
  });
});

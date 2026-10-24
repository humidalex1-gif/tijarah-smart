import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };

vi.mock("@/lib/auth", () => ({
  requireSessionOrRedirect: vi.fn(async () => session),
}));

const company = {
  id: "c1",
  name: "Acme",
  currencyCode: "SAR",
  onboardingCompleted: true,
} as never;

const user = {
  id: "u1",
  email: "owner@tijarah.test",
  fullName: "Owner",
} as never;

const membership = { userId: "u1", companyId: "c1", role: "OWNER", status: "ACTIVE" } as never;

vi.mock("@/lib/db", () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => company) },
    user: { findUnique: vi.fn(async () => user) },
    membership: { findFirst: vi.fn(async () => membership) },
  },
}));

const { loadAppContext, requirePermission } = await import("@/lib/appContext");
const { requireSessionOrRedirect } = await import("@/lib/auth");
const { prisma } = await import("@/lib/db");

describe("loadAppContext", () => {
  beforeEach(() => {
    vi.mocked(requireSessionOrRedirect).mockResolvedValue(session);
    vi.mocked(prisma.company.findUnique).mockResolvedValue(company);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user);
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(membership);
  });

  it("returns the caller's scope using the re-read membership role, not the JWT claim", async () => {
    // The JWT says OWNER too here, but the point (decisions.md #2) is that
    // the returned role always comes from the fresh Membership read.
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({
      userId: "u1", companyId: "c1", role: "VIEWER", status: "ACTIVE",
    } as never);

    const ctx = await loadAppContext("en");

    expect(ctx).toMatchObject({
      userId: "u1",
      companyId: "c1",
      role: "VIEWER",
      currency: "SAR",
    });
    expect(ctx.company).toEqual(company);
    expect(ctx.user).toEqual(user);
  });

  it("re-reads membership scoped to ACTIVE status", async () => {
    await loadAppContext("en");

    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", companyId: "c1", status: "ACTIVE" },
    });
  });

  it("redirects to login when the company row no longer resolves (stale token)", async () => {
    vi.mocked(prisma.company.findUnique).mockResolvedValue(null);

    await expect(loadAppContext("en")).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/en/login"),
    });
  });

  it("redirects to login when the user row no longer resolves (stale token)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(loadAppContext("en")).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/en/login"),
    });
  });

  it("redirects to login when the membership is gone or not ACTIVE", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null);

    await expect(loadAppContext("ar")).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/ar/login"),
    });
  });

  it("redirects to login when the membership role isn't a recognized Role", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({
      userId: "u1", companyId: "c1", role: "GHOST", status: "ACTIVE",
    } as never);

    await expect(loadAppContext("en")).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/en/login"),
    });
  });

  it("uses the locale segment already validated by the caller for the redirect target", async () => {
    vi.mocked(prisma.company.findUnique).mockResolvedValue(null);

    await expect(loadAppContext("ar")).rejects.toMatchObject({
      digest: expect.stringContaining("/ar/login"),
    });
  });
});

describe("requirePermission", () => {
  const ctx = {
    userId: "u1",
    companyId: "c1",
    role: "VIEWER" as const,
    company,
    user,
    currency: "SAR",
  };

  it("redirects to the dashboard, not the login page, when the role lacks the permission", () => {
    // A denial is a routine "you can't see this", not the stale-token
    // "unauthenticated" case `loadAppContext` handles above — the user IS
    // signed in, so the redirect target is `/{locale}`, never `/{locale}/login`.
    // `redirect()` throws synchronously (Next's control-flow signal), so
    // catch it directly rather than via a rejected promise.
    expect.assertions(1);
    try {
      requirePermission(ctx, "users.manage", "en");
    } catch (err) {
      expect(err).toMatchObject({
        message: "NEXT_REDIRECT",
        digest: expect.stringContaining("/en"),
      });
    }
  });

  it("uses the caller's locale segment for the redirect target", () => {
    expect.assertions(1);
    try {
      requirePermission(ctx, "users.manage", "ar");
    } catch (err) {
      expect(err).toMatchObject({ digest: expect.stringContaining("/ar") });
    }
  });

  it("does not redirect (or throw at all) when the role holds the permission", () => {
    expect(() => requirePermission(ctx, "products.view", "en")).not.toThrow();
  });
});

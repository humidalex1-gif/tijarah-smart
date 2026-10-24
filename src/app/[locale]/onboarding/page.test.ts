import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSessionOrRedirect: vi.fn(async () => session) }));
vi.mock("@/lib/db", () => ({ prisma: { company: { findUnique: vi.fn() } } }));

const OnboardingPage = (await import("./page")).default;
const { requireSessionOrRedirect } = await import("@/lib/auth");
const { prisma } = await import("@/lib/db");

describe("OnboardingPage", () => {
  beforeEach(() => {
    vi.mocked(requireSessionOrRedirect).mockResolvedValue(session);
  });

  it("redirects to login instead of throwing when the session's company no longer resolves", async () => {
    // The JWT is a cache, not authority (docs/decisions.md #2): a token can
    // outlive the row it points at (company deleted, stale dev data, etc.)
    // for up to its 24h maxAge. findUniqueOrThrow would surface that as an
    // unhandled P2025 500; findUnique + an explicit redirect treats a
    // resolvable-token/missing-row mismatch as unauthenticated instead.
    vi.mocked(prisma.company.findUnique).mockResolvedValue(null as never);

    // redirect() throws by design (Next's control-flow signal) — assert on
    // the thrown error rather than a return value.
    await expect(
      OnboardingPage({ params: Promise.resolve({ locale: "en" }) }),
    ).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/en/login"),
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
vi.mock("@/services/accounts", () => ({ completeOnboarding: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    company: { findUnique: vi.fn() },
    membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) },
  },
}));

const { onboardingAction } = await import("./actions");
const { requireSession } = await import("@/lib/auth");
const { completeOnboarding } = await import("@/services/accounts");
const { prisma } = await import("@/lib/db");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

// A direct POST to this action (bypassing the browser's <input type="number">
// clamping) must fail validation and return the same translated-error shape
// as any other bad input — never throw an unhandled exception or reach
// completeOnboarding with garbage.
const validFields = {
  companyName: "Acme Trading",
  currencyCode: "SAR",
  taxRate: "15",
  warehouseName: "Main Warehouse",
  locale: "en",
};

describe("onboardingAction validation", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue(session);
    vi.mocked(completeOnboarding).mockClear();
    vi.mocked(prisma.company.findUnique).mockResolvedValue({ id: "c1" } as never);
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);
  });

  // The only guard against replay used to be a redirect on the onboarding
  // PAGE — this action is an independently addressable POST endpoint, so a
  // page redirect gates nothing. A VIEWER holds no create/edit permission at
  // all and must still be refused calling it directly.
  it("refuses a non-OWNER member", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "VIEWER" } as never);

    const result = await onboardingAction(null, form(validFields));

    expect(result).toEqual({ error: "errors.FORBIDDEN" });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("refuses a member with no active membership in this company", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null as never);

    const result = await onboardingAction(null, form(validFields));

    expect(result).toEqual({ error: "errors.FORBIDDEN" });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  // `fields` (a per-field dictionary-key map, same shape as registerAction's
  // return) lets OnboardingForm surface each bad value next to its own
  // input instead of only the generic banner (Stage 1B review, CRITICAL 1).
  it("rejects a non-numeric tax rate instead of computing NaN basis points", async () => {
    const result = await onboardingAction(null, form({ ...validFields, taxRate: "abc" }));

    expect(result).toEqual({
      error: "errors.generic",
      fields: { taxRate: ["errors.INVALID_TAX_RATE"] },
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects a negative tax rate", async () => {
    const result = await onboardingAction(null, form({ ...validFields, taxRate: "-50" }));

    expect(result).toEqual({
      error: "errors.generic",
      fields: { taxRate: ["errors.INVALID_TAX_RATE"] },
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects a tax rate above 100%", async () => {
    const result = await onboardingAction(null, form({ ...validFields, taxRate: "150" }));

    expect(result).toEqual({
      error: "errors.generic",
      fields: { taxRate: ["errors.INVALID_TAX_RATE"] },
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric opening cash balance instead of throwing toMinor's bare Error", async () => {
    const result = await onboardingAction(null, form({ ...validFields, openingCash: "abc" }));

    expect(result).toEqual({
      error: "errors.generic",
      fields: { openingCash: ["errors.INVALID_AMOUNT"] },
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects a negative opening bank balance", async () => {
    const result = await onboardingAction(null, form({ ...validFields, openingBank: "-1" }));

    expect(result).toEqual({
      error: "errors.generic",
      fields: { openingBank: ["errors.INVALID_AMOUNT"] },
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects a currency code that isn't three letters", async () => {
    const result = await onboardingAction(null, form({ ...validFields, currencyCode: "12$" }));

    expect(result).toEqual({
      error: "errors.generic",
      fields: { currencyCode: ["errors.INVALID_CURRENCY_CODE"] },
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("redirects to login instead of throwing when the session's company no longer resolves", async () => {
    // Same stale-token hazard as onboarding/page.tsx, but via POST: a stale
    // session replays this form, or the company is deleted between page load
    // and submit. completeOnboarding's bare `tx.company.update({ where: {
    // id } })` would throw Prisma's P2025 (not a ServiceError) and reach the
    // error boundary as an unhandled 500 if this guard weren't here.
    vi.mocked(prisma.company.findUnique).mockResolvedValue(null as never);

    // redirect() throws by design (Next's control-flow signal) — assert on
    // the thrown error rather than a return value.
    await expect(onboardingAction(null, form(validFields))).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/en/login"),
    });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
});

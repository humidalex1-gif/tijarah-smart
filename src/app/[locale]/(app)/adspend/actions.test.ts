import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/adspend", () => ({
  recordAdSpend: vi.fn(async () => ({ adSpendId: "a1" })),
}));

const actions = await import("./actions");
const { prisma } = await import("@/lib/db");
const svc = await import("@/services/adspend");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

const validForm = (over: Record<string, string> = {}) =>
  form({
    channel: "META",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    amount: "400",
    productId: "",
    campaign: "",
    ...over,
  });

describe("recordAdSpendAction gate", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.clearAllMocks();
  });

  it("lets an accountant record advertising spend", async () => {
    mockRole("ACCOUNTANT");

    const result = await actions.recordAdSpendAction(validForm());

    expect(result.ok).toBe(true);
    expect(svc.recordAdSpend).toHaveBeenCalled();
  });

  it("refuses a warehouse manager, without calling the service", async () => {
    // Reconciling stock is that role's job; what the business spends on
    // advertising is not.
    mockRole("WAREHOUSE_MANAGER");

    const result = await actions.recordAdSpendAction(validForm());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(svc.recordAdSpend).not.toHaveBeenCalled();
  });

  it("refuses a sales employee, without calling the service", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await actions.recordAdSpendAction(validForm());

    expect(result.ok).toBe(false);
    expect(svc.recordAdSpend).not.toHaveBeenCalled();
  });

  it("refuses a viewer, without calling the service", async () => {
    mockRole("VIEWER");

    const result = await actions.recordAdSpendAction(validForm());

    expect(result.ok).toBe(false);
    expect(svc.recordAdSpend).not.toHaveBeenCalled();
  });

  it("converts the typed amount to minor units", async () => {
    mockRole("OWNER");

    await actions.recordAdSpendAction(validForm({ amount: "400" }));

    expect(svc.recordAdSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 40000 }),
    );
  });

  it("maps a blank product to null so the spend is pooled, not attributed", async () => {
    mockRole("OWNER");

    await actions.recordAdSpendAction(validForm({ productId: "" }));

    expect(svc.recordAdSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ productId: null }),
    );
  });

  it("rejects a negative amount without calling the service", async () => {
    mockRole("OWNER");

    const result = await actions.recordAdSpendAction(validForm({ amount: "-5" }));

    expect(result.ok).toBe(false);
    expect(svc.recordAdSpend).not.toHaveBeenCalled();
  });

  it("rejects an unknown channel without calling the service", async () => {
    mockRole("OWNER");

    const result = await actions.recordAdSpendAction(validForm({ channel: "PIGEON" }));

    expect(result.ok).toBe(false);
    expect(svc.recordAdSpend).not.toHaveBeenCalled();
  });
});

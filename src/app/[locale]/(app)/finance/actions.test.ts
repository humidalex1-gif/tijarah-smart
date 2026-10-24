import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action() re-reads
// Membership, so the test has to control that read (same pattern as
// src/lib/action.test.ts and inventory/actions.test.ts).
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/accounts", () => ({
  createAccount: vi.fn(async () => ({ id: "acc-1" })),
}));
vi.mock("@/services/payments", () => ({
  recordCustomerPayment: vi.fn(async () => ({ paymentId: "pay-1", paymentNumber: "PAY-1" })),
  recordSupplierPayment: vi.fn(async () => ({ paymentId: "pay-2", paymentNumber: "PAY-2" })),
  transferBetweenAccounts: vi.fn(async () => ({ paymentId: "pay-3", paymentNumber: "PAY-3" })),
}));

const {
  recordCustomerPaymentAction, recordSupplierPaymentAction, transferBetweenAccountsAction,
} = await import("./actions");
const { prisma } = await import("@/lib/db");
const { recordSupplierPayment, transferBetweenAccounts } = await import("@/services/payments");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

describe("finance payment actions permission gates", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.mocked(recordSupplierPayment).mockClear();
    vi.mocked(transferBetweenAccounts).mockClear();
  });

  // SALES_EMPLOYEE holds payments.create (records payments on /sales/[id])
  // but neither purchases.view nor finance.manage_accounts — the exact
  // combination the standalone /finance/payments/new page must not grant
  // beyond the customer-payment tab it's actually built for.
  it("rejects a supplier payment from a role with payments.create but not purchases.view", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await recordSupplierPaymentAction(form({
      supplierId: "s1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(recordSupplierPayment).not.toHaveBeenCalled();
  });

  it("rejects an account transfer from a role with payments.create but not finance.manage_accounts", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await transferBetweenAccountsAction(form({
      fromAccountId: "a1", toAccountId: "a2", amount: "100",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(transferBetweenAccounts).not.toHaveBeenCalled();
  });

  it("allows a supplier payment from a role holding both payments.create and purchases.view", async () => {
    mockRole("ACCOUNTANT");

    const result = await recordSupplierPaymentAction(form({
      supplierId: "s1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(true);
    expect(recordSupplierPayment).toHaveBeenCalled();
  });

  it("allows an account transfer from a role holding both payments.create and finance.manage_accounts", async () => {
    mockRole("ACCOUNTANT");

    const result = await transferBetweenAccountsAction(form({
      fromAccountId: "a1", toAccountId: "a2", amount: "100",
    }));

    expect(result.ok).toBe(true);
    expect(transferBetweenAccounts).toHaveBeenCalled();
  });

  it("still allows a customer payment from a role holding only payments.create", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await recordCustomerPaymentAction(form({
      customerId: "c1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(true);
  });
});

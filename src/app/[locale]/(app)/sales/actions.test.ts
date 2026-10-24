import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action() re-reads
// Membership, so the test has to control that read (same pattern as
// src/lib/action.test.ts and finance/actions.test.ts).
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/sales", () => ({
  createSalesOrder: vi.fn(),
  confirmSale: vi.fn(),
  cancelSale: vi.fn(),
  processReturn: vi.fn(),
}));
vi.mock("@/services/payments", () => ({
  recordCustomerPayment: vi.fn(async () => ({ paymentId: "pay-1", paymentNumber: "PAY-1" })),
}));

const salesActions = await import("./actions");
const { recordCustomerPaymentAction } = await import("../finance/actions");
const { prisma } = await import("@/lib/db");
const { recordCustomerPayment } = await import("@/services/payments");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

// recordCustomerPaymentAction used to be defined TWICE — once here and once
// in finance/actions.ts — with SaleDetailActions.tsx calling this copy and
// PaymentForm.tsx calling the other. The two were byte-identical, so nothing
// was exploitable, but that is the property that has to hold FOREVER for it
// to stay safe, and nothing enforced it.
//
// That exact shape is what produced the recordSupplierPaymentAction
// escalation: two copies, an earlier hardening fix applied to one of them,
// and a SALES_EMPLOYEE able to post an uncapped supplier payment through the
// copy that had been missed. It was invisible to per-task review and to the
// suite, because the test file only ever imported the safe copy.
//
// Fix: delete the duplicate. SaleDetailActions.tsx now imports the single
// definition from finance/actions.ts, mirroring PurchaseDetailActions.tsx.
// This file guards both ends — there is no second copy to diverge, and the
// one action the sale detail page actually calls still enforces its gate.
describe("sales feature has no independent recordCustomerPaymentAction", () => {
  it("does not export its own copy from sales/actions.ts", () => {
    expect((salesActions as Record<string, unknown>).recordCustomerPaymentAction).toBeUndefined();
  });
});

describe("recordCustomerPaymentAction gate, as used by the sale detail page", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.mocked(recordCustomerPayment).mockClear();
  });

  it("rejects a customer payment from a role without payments.create", async () => {
    // VIEWER is read-only: it holds sales.view and customers.view, so it can
    // reach the sale detail page, but must not be able to post a payment
    // against it via a raw POST.
    mockRole("VIEWER");

    const result = await recordCustomerPaymentAction(form({
      customerId: "c1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(recordCustomerPayment).not.toHaveBeenCalled();
  });

  it("allows a customer payment from a role holding payments.create", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await recordCustomerPaymentAction(form({
      customerId: "c1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(true);
    expect(recordCustomerPayment).toHaveBeenCalled();
  });
});

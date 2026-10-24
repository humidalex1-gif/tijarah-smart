import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action() re-reads
// Membership, so the test has to control that read (same pattern as
// src/lib/action.test.ts and finance/actions.test.ts).
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/purchases", () => ({
  createPurchaseOrder: vi.fn(),
  confirmPurchaseOrder: vi.fn(),
  receivePurchase: vi.fn(),
  cancelPurchaseOrder: vi.fn(),
}));
vi.mock("@/services/payments", () => ({
  recordSupplierPayment: vi.fn(async () => ({ paymentId: "pay-2", paymentNumber: "PAY-2" })),
}));

const purchasesActions = await import("./actions");
const { recordSupplierPaymentAction } = await import("../finance/actions");
const { prisma } = await import("@/lib/db");
const { recordSupplierPayment } = await import("@/services/payments");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

// The earlier hardening (payments.create + purchases.view) landed only in
// finance/actions.ts; purchases/actions.ts carried its own copy of
// recordSupplierPaymentAction gated on bare "payments.create", so a
// SALES_EMPLOYEE (payments.create but not purchases.view) could reach an
// uncapped supplier payment through the purchases page even though
// PaymentForm.tsx's copy was safe. finance/actions.test.ts only ever
// exercised the finance/actions.ts copy and there was no test file here at
// all, so the suite was blind to the second, unhardened copy.
//
// Fix: delete the duplicate outright — PurchaseDetailActions.tsx now imports
// recordSupplierPaymentAction from finance/actions.ts instead of re-exporting
// its own. This file guards both ends of that fix: there is no independent
// copy to regress on, and the one action the purchase-order detail page
// actually calls still carries the full AND gate.
describe("purchases feature has no independent recordSupplierPaymentAction", () => {
  it("does not export its own copy from purchases/actions.ts", () => {
    expect((purchasesActions as Record<string, unknown>).recordSupplierPaymentAction).toBeUndefined();
  });
});

describe("recordSupplierPaymentAction gate, as used by the purchase order detail page", () => {
  beforeEach(() => {
    mockRole("OWNER");
    vi.mocked(recordSupplierPayment).mockClear();
  });

  it("rejects a supplier payment from a role with payments.create but not purchases.view", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await recordSupplierPaymentAction(form({
      supplierId: "s1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(recordSupplierPayment).not.toHaveBeenCalled();
  });

  it("allows a supplier payment from a role holding both payments.create and purchases.view", async () => {
    mockRole("ACCOUNTANT");

    const result = await recordSupplierPaymentAction(form({
      supplierId: "s1", accountId: "a1", amount: "100",
    }));

    expect(result.ok).toBe(true);
    expect(recordSupplierPayment).toHaveBeenCalled();
  });
});

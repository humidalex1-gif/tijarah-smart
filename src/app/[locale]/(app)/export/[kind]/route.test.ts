import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The CSV routes, called directly as functions.
 *
 * What must hold: the permission gates return 403 before any query runs, the
 * profit columns exist only for a role that may see profit, and the body
 * starts with the BOM Excel needs before it will read Arabic as UTF-8.
 */

const ctx = {
  userId: "u1", companyId: "c1", role: "ACCOUNTANT" as string,
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Thomas" } as never,
  currency: "SAR",
};

vi.mock("@/lib/appContext", () => ({ loadAppContext: vi.fn(async () => ctx) }));

const orderFindMany = vi.hoisted(() => vi.fn(async () => [{
  salesOrderNumber: "SO-0003", orderDate: new Date("2026-07-15T10:00:00Z"),
  status: "CONFIRMED", channel: "FASTHUB",
  subtotal: 25900, shippingCharged: 0, refundedAmount: 0, grandTotal: 25900,
  grossProfit: 11300, netProfit: 9800,
  customer: { name: "عميل, تجريبي" },
}]));
const expenseFindMany = vi.hoisted(() => vi.fn(async () => [{
  expenseNumber: "EXP-0001", expenseDate: new Date("2026-08-02T10:00:00Z"),
  status: "POSTED", description: "شحن",
  amount: 5000, taxAmount: 750, totalAmount: 5750,
  category: { nameAr: "شحن", nameEn: "Shipping" },
}]));
vi.mock("@/lib/db", () => ({
  prisma: {
    salesOrder: { findMany: orderFindMany },
    expense: { findMany: expenseFindMany },
  },
}));

const can = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  can,
}));

const { GET } = await import("./route");

const call = (kind: string) =>
  GET(new Request("http://x"), { params: Promise.resolve({ locale: "ar", kind }) });

describe("export route", () => {
  beforeEach(() => {
    can.mockReturnValue(true);
    orderFindMany.mockClear();
    expenseFindMany.mockClear();
  });

  it("exports sales as UTF-8 CSV with the Excel BOM first", async () => {
    const res = await call("sales");
    // Raw bytes, not text(): a UTF-8 TextDecoder strips a leading BOM as part
    // of decoding, so asserting on the decoded string passes with or without
    // it. Excel reads the BYTES, and these three must come first.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const body = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/csv");
    // Without this BOM, Excel on Windows renders كل الأسماء العربية mojibake.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body).toContain("SO-0003");
    expect(body).toContain("259.00");
    // A comma inside a customer name must not become a column.
    expect(body).toContain('"عميل, تجريبي"');
  });

  it("includes profit columns only for a role that may see profit", async () => {
    const withProfit = await (await call("sales")).text();
    expect(withProfit).toContain("gross_profit");
    expect(withProfit).toContain("113.00");

    can.mockImplementation((...a: unknown[]) => a[1] !== "finance.view_profit");
    const without = await (await call("sales")).text();
    // Absent from the header AND the rows: a download pasted into a chat must
    // not carry figures the screen itself would hide.
    expect(without).not.toContain("gross_profit");
    expect(without).not.toContain("113.00");
  });

  it("refuses sales entirely without sales.view, before any query", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "sales.view");
    const res = await call("sales");

    expect(res.status).toBe(403);
    expect(orderFindMany).not.toHaveBeenCalled();
  });

  it("exports expenses with the locale's category name", async () => {
    const body = await (await call("expenses")).text();

    expect(body).toContain("EXP-0001");
    expect(body).toContain("شحن");
    expect(body).toContain("57.50");
  });

  it("refuses expenses without expenses.view", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "expenses.view");
    const res = await call("expenses");

    expect(res.status).toBe(403);
    expect(expenseFindMany).not.toHaveBeenCalled();
  });

  it("404s an unknown kind instead of crashing", async () => {
    expect((await call("everything")).status).toBe(404);
  });
});

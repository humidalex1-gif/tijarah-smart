import { describe, it, expect, vi, beforeEach } from "vitest";
import { QuickEntry } from "./QuickEntry";

// Same structural walk as `dashboard/page.test.ts`: an async Server Component
// invoked directly returns a plain element graph, inspectable without a DOM.
interface ElementLike { type: unknown; key: string | null; props?: Record<string, unknown> }
function isElementLike(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null && "type" in node;
}
function collectByType(node: unknown, type: unknown, found: ElementLike[] = []): ElementLike[] {
  if (Array.isArray(node)) {
    for (const n of node) collectByType(n, type, found);
    return found;
  }
  if (!isElementLike(node)) return found;
  if (node.type === type) found.push(node);
  if (node.props?.children !== undefined) collectByType(node.props.children, type, found);
  return found;
}

const ctx = {
  userId: "u1",
  companyId: "c1",
  role: "ACCOUNTANT" as string,
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Thomas" } as never,
  currency: "SAR",
};

const CATEGORIES = [
  { id: "cat-ads", nameAr: "إعلانات", nameEn: "Advertising" },
  { id: "cat-ship", nameAr: "شحن", nameEn: "Shipping" },
];

const db = {
  categories: CATEGORIES as unknown[],
  account: { id: "acc-cash", name: "Cash" } as { id: string; name: string } | null,
};

vi.mock("@/lib/appContext", () => ({
  loadAppContext: vi.fn(async () => ctx),
  requirePermission: vi.fn(),
}));

// `QuickEntry` imports the expense server action, whose `action()` wrapper
// pulls in next-auth and fails to resolve outside a Next runtime. This page
// never calls it — the client component does, and its own test covers that.
vi.mock("../expenses/actions", () => ({ addExpenseAction: vi.fn(), cancelExpenseAction: vi.fn() }));
vi.mock("../finance/actions", () => ({ recordSupplierPaymentAction: vi.fn() }));
vi.mock("../sales/actions", () => ({ createSalesOrderAction: vi.fn() }));
vi.mock("../products/actions", () => ({ createProductAction: vi.fn() }));

// Typed with the args parameter so the where-clause assertion below can read
// what the page actually queried, rather than an empty argument tuple.
const productFindMany = vi.hoisted(() => vi.fn(async (_args: { where: Record<string, unknown> }) => [
  { id: "p1", nameAr: "وعاء", nameEn: "Caddy", sellingPrice: 7100 },
]));
const warehouseFindFirst = vi.hoisted(() => vi.fn(async () => ({ id: "wh-main" })));

const supplierFindMany = vi.hoisted(() =>
  vi.fn(async () => [{ id: "sup1", name: "Fast Hub" }]),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    expenseCategory: { findMany: vi.fn(async () => db.categories) },
    financialAccount: { findFirst: vi.fn(async () => db.account) },
    product: { findMany: productFindMany },
    warehouse: { findFirst: warehouseFindFirst },
    supplier: { findMany: supplierFindMany },
  },
}));

vi.mock("@/services/reporting", () => ({
  salesSummary: vi.fn(async () => ({ revenue: 77_700, orderCount: 3, grossProfit: 0, netProfit: 0 })),
}));

// `can` is mocked (not the role) for the sales-figure test below, for the same
// reason `dashboard/page.test.ts` mocks it: no role in `PERMISSIONS` today
// holds `expenses.create` without `sales.view` — OWNER/ADMIN are `*` and
// ACCOUNTANT holds both — so no real role can reach that branch. The gate is
// there because the figure is built into props for a `"use client"` component,
// where computing it unconditionally would ship it in the RSC payload even
// with the card hidden (non-negotiable rule 4).
const can = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  can,
}));

const QuickPage = (await import("./page")).default;
const { requirePermission } = await import("@/lib/appContext");
const { salesSummary } = await import("@/services/reporting");

const args = { params: Promise.resolve({ locale: "ar" }) };

describe("QuickPage", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    vi.mocked(salesSummary).mockClear();
    supplierFindMany.mockClear();
    can.mockReturnValue(true);
    productFindMany.mockClear();
    db.categories = CATEGORIES;
    db.account = { id: "acc-cash", name: "Cash" };
  });

  it("gates on expenses.create, the strongest permission anything it saves needs", async () => {
    await QuickPage(args);
    expect(requirePermission).toHaveBeenCalledWith(ctx, "expenses.create", "ar");
  });

  it("propagates a redirect thrown by requirePermission instead of swallowing it", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/ar;307;" });
    vi.mocked(requirePermission).mockImplementation(() => { throw redirect; });
    await expect(QuickPage(args)).rejects.toMatchObject({ message: "NEXT_REDIRECT" });
  });

  it("hands the entry screen the real categories and the first active account", async () => {
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect(entry).toBeDefined();
    expect(entry!.props!.categories).toEqual(CATEGORIES);
    // Named on screen rather than asked for: the account is the one thing the
    // three-tap flow decides on the owner's behalf.
    expect(entry!.props!.accountId).toBe("acc-cash");
    expect(entry!.props!.accountName).toBe("Cash");
  });

  it("passes today's figures through the dashboard's own reporting function", async () => {
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    // Reused, never recomputed — a second definition of "today's sales" that
    // disagreed with the dashboard's would be worse than showing nothing.
    expect(salesSummary).toHaveBeenCalledTimes(1);
    expect((entry!.props!.today as { revenue: number }).revenue).toBe(77_700);
    // Resolved server-side, where the plural rules live: Arabic's `few`
    // category for 3, with Arabic-Indic digits — not the "other" form "٣ طلب"
    // a client-side `{count}` fill would have produced.
    expect((entry!.props!.today as { ordersLabel: string }).ordersLabel).toBe("٣ طلبات");
  });

  it("withholds today's figures, and does not even query them, without sales.view", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "sales.view");
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect(entry!.props!.today).toBeUndefined();
    // Not merely hidden: never fetched, so it cannot reach the RSC payload.
    expect(salesSummary).not.toHaveBeenCalled();
  });


  it("hands the sale flow the default warehouse and only sellable products", async () => {
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    const sale = entry!.props!.sale as { warehouseId: string; products: unknown[] };
    expect(sale.warehouseId).toBe("wh-main");
    expect(sale.products).toHaveLength(1);
    // The where clause IS the data-safety contract: a bundle has no shelf of
    // its own (customer-configured ones would throw BUNDLE_RECIPE_MISSING mid-
    // sale), and a zero-priced product sold by mis-tap books revenue 0 while
    // depleting real stock.
    const where = productFindMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ status: "ACTIVE", isBundle: false, sellingPrice: { gt: 0 } });
    expect(entry!.props!.productEntry).toBe(true);
  });

  it("withholds the sale flow, and does not query products, without sales.create", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "sales.create");
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect(entry!.props!.sale).toBeUndefined();
    expect(productFindMany).not.toHaveBeenCalled();
  });

  it("withholds the sale flow without payments.create, which the one-submit confirm also posts", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "payments.create");
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    // The quick sale records its payment in the same submit, so sales.create
    // alone must not light the button — same pairing the action declares.
    expect(entry!.props!.sale).toBeUndefined();
  });

  it("disables product entry without inventory.receive, which createProductAction pairs in", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "inventory.receive");
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect(entry!.props!.productEntry).toBe(false);
  });

  it("says what is missing instead of offering a save that would be refused", async () => {
    db.account = null;
    const tree = await QuickPage(args);

    expect(collectByType(tree, QuickEntry)).toHaveLength(0);
  });

  it("does the same when no expense category exists", async () => {
    db.categories = [];
    const tree = await QuickPage(args);

    expect(collectByType(tree, QuickEntry)).toHaveLength(0);
  });

  it("hands the payment flow the active suppliers and marks undo for a role that can cancel", async () => {
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect((entry!.props! as { payment?: { suppliers: unknown[] } }).payment).toEqual({
      suppliers: [{ id: "sup1", name: "Fast Hub" }],
    });
    expect((entry!.props! as { canUndo?: boolean }).canUndo).toBe(true);
  });

  it("withholds the payment flow, and does not query suppliers, without purchases.view", async () => {
    // recordSupplierPaymentAction itself demands payments.create AND
    // purchases.view; a chip list lit by half the pair refuses when tapped.
    can.mockImplementation((...a: unknown[]) => a[1] !== "purchases.view");
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect((entry!.props! as { payment?: unknown }).payment).toBeUndefined();
    expect(supplierFindMany).not.toHaveBeenCalled();
  });

  it("offers no undo to a role without expenses.cancel", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "expenses.cancel");
    const tree = await QuickPage(args);
    const [entry] = collectByType(tree, QuickEntry);

    expect((entry!.props! as { canUndo?: boolean }).canUndo).toBe(false);
  });
});

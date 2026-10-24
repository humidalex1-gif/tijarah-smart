import { describe, it, expect, vi, beforeEach } from "vitest";
import { KpiCard } from "@/components/ui/KpiCard";
import { PendingActions, type PendingRow } from "./PendingActions";
import { TokenExpiryNotice } from "@/components/shell/TokenExpiryNotice";
import { DataTable } from "@/components/ui/DataTable";
import { SyncAlert } from "@/components/shell/SyncAlert";

// Minimal structural walk of the React element tree DashboardPage returns —
// it is an async Server Component invoked directly (not run through
// react-dom/testing-library), so its return value is a plain element graph
// we can inspect without rendering.
interface ElementLike { type: unknown; key: string | null; props?: { children?: unknown } }
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

// Every real Role in `PERMISSIONS` holds `dashboard.view` (by design — see
// `permissions.ts`), so no actual role can exercise the denial branch on
// THIS page today. These tests instead verify the WIRING Task 4's Fix 1
// introduced: the dashboard calls `requirePermission`, and `requirePermission`
// redirects rather than throws when `can()` says no. `permissions.can` is
// mocked (not the role) to force that branch — Tasks 5–9's finance/expenses
// pages are where a real role (SALES_EMPLOYEE) hits this for real.
const ctx: { role: "SALES_EMPLOYEE" | "VIEWER"; [k: string]: unknown } = {
  userId: "u1",
  companyId: "c1",
  role: "SALES_EMPLOYEE",
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Khalid" } as never,
  currency: "SAR",
};

vi.mock("@/lib/appContext", () => ({
  loadAppContext: vi.fn(async () => ctx),
  requirePermission: vi.fn(),
}));

vi.mock("@/services/attention", () => ({
  pendingActions: vi.fn(async () => ({
    zeroCostSold: 3, openClaims: 2, draftOrders: 1, lowStock: 4,
  })),
}));

vi.mock("@/services/reporting", () => ({
  salesSummary: vi.fn(async () => ({ revenue: 0, orderCount: 0, grossProfit: 0, netProfit: 0 })),
  expenseTotal: vi.fn(async () => 0),
  inventoryValue: vi.fn(async () => ({ totalValue: 0, totalUnits: 0 })),
  cashPosition: vi.fn(async () => ({ total: 0, cash: 0, bank: 0 })),
  receivables: vi.fn(async () => 0),
  payables: vi.fn(async () => 0),
  lowStockProducts: vi.fn(async () => []),
  bestSellers: vi.fn(async () => []),
  salesSeries: vi.fn(async () => []),
}));

// The two reads added with the "smarter" work. Both are hoisted so a test can
// steer them; both default to "nothing to say".
const getFastHubStatus = vi.hoisted(() => vi.fn(async () => ({
  clientId: null as string | null, configured: false, connected: false, sellerName: null as string | null,
  accessValid: false, accessExpiresAt: null as Date | null, refreshExpiresAt: null,
  lastPolledAt: null, connectedAt: null,
})));
vi.mock("@/services/fasthub/connection", () => ({ getFastHubStatus }));

const stockoutForecast = vi.hoisted(() => vi.fn(async () => [] as {
  productId: string; sku: string; nameAr: string; nameEn: string;
  availableQty: number; soldInWindow: number; unitsPerDay: number; daysOfCover: number; suggestedQty: number;
}[]));
vi.mock("@/services/forecast", () => ({ stockoutForecast }));

const openSyncAttention = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@/services/fasthub/syncRun", () => ({ openSyncAttention }));
const explainDifferences = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, unknown>));
vi.mock("@/services/fasthub/explainDifferences", () => ({ explainDifferences }));

const DashboardPage = (await import("./page")).default;
const { requirePermission } = await import("@/lib/appContext");

const args = {
  params: Promise.resolve({ locale: "en" }),
  searchParams: Promise.resolve({}),
};

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    ctx.role = "SALES_EMPLOYEE";
  });

  it("gates the page through requirePermission (not assertCan) for dashboard.view", async () => {
    // requirePermission itself redirects on denial (see appContext.test.ts);
    // here we assert the page actually calls it, with this page's ctx/
    // permission/locale, instead of a raw `assertCan`.
    await DashboardPage(args);

    expect(requirePermission).toHaveBeenCalledWith(ctx, "dashboard.view", "en");
  });

  it("propagates a redirect thrown by requirePermission instead of swallowing it", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/en;307;" });
    vi.mocked(requirePermission).mockImplementation(() => {
      throw redirectError;
    });

    await expect(DashboardPage(args)).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/en"),
    });
  });

  it("renders (does not redirect) when requirePermission allows the request through, showing only the KPIs SALES_EMPLOYEE's permissions allow", async () => {
    // requirePermission is a no-op mock by default (beforeEach reset), i.e.
    // "permitted" — the page must resolve to real markup, not throw/redirect
    // and not just resolve to some arbitrary defined value. `can()` itself
    // is NOT mocked, so this exercises the real SALES_EMPLOYEE permission
    // set (src/lib/permissions.ts): sales.view and inventory.view but not
    // finance.view/finance.view_profit/finance.view_cost/expenses.view/
    // suppliers.view — so of the ten possible KPI cards, exactly
    // salesToday, salesTotal, receivables, and lowStock should render.
    const result = await DashboardPage(args);

    const kpiCards = collectByType(result, KpiCard);
    expect(kpiCards.map((c) => c.key).sort()).toEqual(
      ["lowStock", "receivables", "salesToday", "salesTotal"].sort(),
    );
  });

  it("hides payables but not receivables from a VIEWER, who may see suppliers without seeing what is owed to them", async () => {
    // VIEWER is the ONLY role that distinguishes the payables card's
    // `extraPermission: "finance.view_cost"` gate: it holds suppliers.view
    // AND customers.view but not finance.view_cost. SALES_EMPLOYEE (the case
    // above) lacks suppliers.view outright, so that test passes identically
    // with or without the gate and cannot pin it.
    //
    // The asymmetry is deliberate, not an oversight — receivables (what
    // customers owe us) is not cost/margin data, payables (what we owe
    // suppliers) is treated as such, matching the suppliers LIST page, which
    // gates its balance column the same way.
    ctx.role = "VIEWER";

    const result = await DashboardPage(args);

    const keys = collectByType(result, KpiCard).map((c) => c.key);
    expect(keys).toContain("receivables");
    expect(keys).not.toContain("payables");
    // Pin the whole VIEWER set too, so a future permission edit that silently
    // widens what a read-only role sees fails here rather than in production.
    expect(keys.sort()).toEqual(
      ["expenses", "lowStock", "receivables", "salesToday", "salesTotal"].sort(),
    );
  });
});

/**
 * The range tabs pointed at `/${locale}`, which the landing page took over on
 * 2026-08-05 when the dashboard moved to `/${locale}/dashboard`. Nobody updated
 * the links, so clicking اليوم or آخر ٧ أيام walked the owner out of the app and
 * onto the public marketing page with its login button — indistinguishable from
 * being logged out, and reported as exactly that.
 */
describe("DashboardPage range tabs", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    ctx.role = "SALES_EMPLOYEE";
  });

  it("links within the app, not out to the marketing page", async () => {
    const NextLink = (await import("next/link")).default;
    const tree = await DashboardPage(args);

    const links = collectByType(tree, NextLink) as (ElementLike & { props: { href: string } })[];
    const rangeLinks = links.filter((l) => String(l.props.href).includes("range="));

    expect(rangeLinks.length).toBeGreaterThan(0);
    for (const link of rangeLinks) {
      expect(String(link.props.href)).toMatch(/^\/en\/dashboard\?range=/);
    }
  });

  it("offers every range key except the custom one", async () => {
    const NextLink = (await import("next/link")).default;
    const { RANGE_KEYS } = await import("@/lib/dateRange");
    const tree = await DashboardPage(args);

    const hrefs = (collectByType(tree, NextLink) as (ElementLike & { props: { href: string } })[])
      .map((l) => String(l.props.href))
      .filter((h) => h.includes("range="));

    for (const key of RANGE_KEYS.filter((k) => k !== "custom")) {
      expect(hrefs).toContain(`/en/dashboard?range=${key}`);
    }
  });
});

/**
 * The "awaiting you" card: pending work, permission-filtered per row.
 *
 * The counts are mocked non-zero above, so what these tests pin is the
 * WIRING — which rows a role is allowed to see, and where each row points.
 * The counting itself is pinned by services/attention.test.ts against a
 * real database.
 */
describe("DashboardPage pending actions", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    ctx.role = "SALES_EMPLOYEE";
  });

  function rowsOf(tree: unknown): PendingRow[] {
    const [card] = collectByType(tree, PendingActions);
    return (card?.props as { rows: PendingRow[] } | undefined)?.rows ?? [];
  }

  it("shows a SALES_EMPLOYEE only the rows their permissions cover", async () => {
    // sales.view and inventory.view, but no finance.view_cost and no
    // reconcile.post — so cost gaps and claims must not reach the RSC payload.
    const keys = rowsOf(await DashboardPage(args)).map((r) => r.key);
    expect(keys.sort()).toEqual(["draftOrders", "lowStock", "runningOut"].sort());
  });

  it("points each row at the screen that resolves it", async () => {
    ctx.role = "VIEWER";
    const rows = rowsOf(await DashboardPage(args));
    const hrefs = Object.fromEntries(rows.map((r) => [r.key, r.href]));
    expect(hrefs.draftOrders).toBe("/en/sales");
    expect(hrefs.lowStock).toBe("/en/inventory?filter=low");
  });
});

describe("DashboardPage smarter reads", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    getFastHubStatus.mockClear();
    stockoutForecast.mockClear();
    stockoutForecast.mockResolvedValue([]);
  });

  it("warns a settings-holder a week before the Fast Hub token dies", async () => {
    (ctx as { role: string }).role = "OWNER";
    getFastHubStatus.mockResolvedValueOnce({
      clientId: "x", configured: true, connected: true, sellerName: "SokuDry",
      accessValid: true, accessExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      refreshExpiresAt: null, lastPolledAt: null, connectedAt: null,
    });

    const tree = await DashboardPage(args);
    const [notice] = collectByType(tree, TokenExpiryNotice);

    expect(notice).toBeDefined();
    expect((notice!.props as { expiry: unknown }).expiry).toEqual({ state: "soon", daysLeft: 3 });
  });

  it("does not even read the token for a role that cannot open the settings screen", async () => {
    // Pointing someone at a page they cannot open is worse than not telling them.
    ctx.role = "SALES_EMPLOYEE";
    await DashboardPage(args);
    expect(getFastHubStatus).not.toHaveBeenCalled();
  });

  it("lists only what runs out inside two weeks, and counts it as pending work", async () => {
    ctx.role = "SALES_EMPLOYEE";
    const row = (sku: string, daysOfCover: number) => ({
      productId: sku, sku, nameAr: sku, nameEn: sku,
      availableQty: 2000, soldInWindow: 20000, unitsPerDay: 666.67, daysOfCover, suggestedQty: 18000,
    });
    stockoutForecast.mockResolvedValueOnce([row("urgent", 3), row("soon", 13.9), row("fine", 45)]);

    const tree = await DashboardPage(args);

    const pending = collectByType(tree, PendingActions)[0]!.props as { rows: PendingRow[] };
    const runningOut = pending.rows.find((r) => r.key === "runningOut");
    expect(runningOut?.count).toBe(2);

    // The forecast table carries exactly the two urgent rows, soonest first,
    // and not the one with a month and a half of cover.
    const tables = collectByType(tree, DataTable).map((el) => (el.props as { rows: { sku?: string }[] }).rows);
    const forecastTable = tables.find((rows) => rows.some((r) => r.sku === "urgent"));
    expect(forecastTable?.map((r) => r.sku)).toEqual(["urgent", "soon"]);
  });
});

describe("DashboardPage sync explanations", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    openSyncAttention.mockResolvedValue([]);
    explainDifferences.mockClear();
  });

  it("asks the reconcile reading for exactly the differences the latest run recorded", async () => {
    (ctx as { role: string }).role = "OWNER";
    const differences = [{ sku: "caddy-coaster-015", fastHub: 90, books: 91 }];
    openSyncAttention.mockResolvedValueOnce([{
      id: "r1", trigger: "SCHEDULED", startedAt: new Date(), finishedAt: new Date(), outcome: "ATTENTION",
      ordersCreated: 0, claimsOpened: 0, diffCount: 1, acknowledgedAt: null,
      attention: {
        unknownSkus: [], preOpening: [], failedOrders: [], draftsUnreadable: [], cancelledAfterConfirm: [],
        qcSplitMissing: [], failedResources: [], differences,
      },
    }]);
    const reading = { "caddy-coaster-015": { settleable: 0, stillClaimed: 0, unexplained: 1, surplus: 0, determinate: true } };
    explainDifferences.mockResolvedValueOnce(reading);

    const tree = await DashboardPage(args);

    expect(explainDifferences).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c1" }), differences);
    const [alert] = collectByType(tree, SyncAlert);
    expect((alert!.props as { explanations: unknown }).explanations).toEqual(reading);
  });
});

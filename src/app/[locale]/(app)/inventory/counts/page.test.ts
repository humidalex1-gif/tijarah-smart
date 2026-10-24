import { describe, it, expect, vi, beforeEach } from "vitest";
import Link from "next/link";
import { DataTable } from "@/components/ui/DataTable";

// Structural walk of the returned element tree, same technique as
// src/app/[locale]/(app)/page.test.ts (the dashboard page test) — this is an
// async Server Component invoked directly, so its return value is a plain
// element graph, never rendered through react-dom.
interface ElementLike { type: unknown; props?: Record<string, unknown> }
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
  const children = node.props?.children;
  if (children !== undefined) collectByType(children, type, found);
  return found;
}

const ctx: { role: string; [k: string]: unknown } = {
  userId: "u1",
  companyId: "c1",
  role: "WAREHOUSE_MANAGER",
  company: { id: "c1", currencyCode: "SAR" } as never,
  user: { id: "u1", fullName: "Khalid" } as never,
  currency: "SAR",
};

vi.mock("@/lib/appContext", () => ({
  loadAppContext: vi.fn(async () => ctx),
  requirePermission: vi.fn(),
}));

const sessionA = {
  id: "s1", countNumber: "CNT-0001", status: "OPEN", scopeType: "WAREHOUSE",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  warehouse: { name: "Main Warehouse" },
  _count: { lines: 5 },
};
const sessionB = {
  id: "s2", countNumber: "CNT-0002", status: "REVIEW", scopeType: "CATEGORY",
  createdAt: new Date("2026-07-02T00:00:00Z"),
  warehouse: { name: "Main Warehouse" },
  _count: { lines: 3 },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    stockCountSession: {
      findMany: vi.fn(async () => [sessionA, sessionB]),
      count: vi.fn(async () => 2),
    },
    stockCountLine: {
      // Only sessionA has an entry — sessionB has zero counted lines, which
      // a groupBy never reports a row for (there is nothing to group). The
      // progress column must treat a missing map entry as zero, not throw
      // or show "undefined".
      groupBy: vi.fn(async () => [{ sessionId: "s1", _count: 2 }]),
    },
  },
}));

const StockCountsPage = (await import("./page")).default;
const { prisma } = await import("@/lib/db");
const { requirePermission } = await import("@/lib/appContext");

const args = {
  params: Promise.resolve({ locale: "en" }),
  searchParams: Promise.resolve({}),
};

describe("StockCountsPage", () => {
  beforeEach(() => {
    ctx.role = "WAREHOUSE_MANAGER";
    vi.mocked(prisma.stockCountSession.findMany).mockClear();
    vi.mocked(prisma.stockCountSession.count).mockClear();
    vi.mocked(prisma.stockCountLine.groupBy).mockClear();
  });

  it("computes each row's progress from the single groupBy, defaulting a session absent from it to zero counted", async () => {
    const result = await StockCountsPage(args);

    // One groupBy call, not one query per session row.
    expect(prisma.stockCountLine.groupBy).toHaveBeenCalledTimes(1);

    const [table] = collectByType(result, DataTable);
    const columns = table.props?.columns as Array<{ key: string; render: (row: unknown) => unknown }>;
    const progressColumn = columns.find((c) => c.key === "progress")!;

    expect(progressColumn.render(sessionA)).toBe("2 / 5");
    expect(progressColumn.render(sessionB)).toBe("0 / 3");
  });

  // There is deliberately no "hides the link for a role lacking
  // inventory.count" test. requirePermission redirects rather than returning,
  // so a role without inventory.count never reaches this render at all — a
  // test for that branch could only run by mocking requirePermission to a
  // no-op, which manufactures a state production cannot produce, and would
  // pin dead code rather than any behaviour a merchant can reach.
  it("offers the 'Start a count' link, since reaching this page already proves the permission", async () => {
    ctx.role = "WAREHOUSE_MANAGER";
    const result = await StockCountsPage(args);

    const links = collectByType(result, Link);
    expect(links.some((l) => l.props?.href === "/en/inventory/counts/new")).toBe(true);
  });

  it("gates the page itself on inventory.count, which is the only gate", async () => {
    // The real protection, and the thing worth pinning: the page calls
    // requirePermission with this exact permission before touching any data.
    await StockCountsPage(args);

    expect(requirePermission).toHaveBeenCalledWith(ctx, "inventory.count", "en");
  });
});

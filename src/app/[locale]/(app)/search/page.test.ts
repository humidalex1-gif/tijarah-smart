import { describe, it, expect, vi, beforeEach } from "vitest";
import { SearchResults } from "./SearchResults";

interface ElementLike { type: unknown; key: string | null; props?: Record<string, unknown> }
function isElementLike(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null && "type" in node;
}
function collectByType(node: unknown, type: unknown, found: ElementLike[] = []): ElementLike[] {
  if (Array.isArray(node)) { for (const n of node) collectByType(n, type, found); return found; }
  if (!isElementLike(node)) return found;
  if (node.type === type) found.push(node);
  if (node.props?.children !== undefined) collectByType(node.props.children, type, found);
  return found;
}

const ctx = {
  userId: "u1", companyId: "c1", role: "ACCOUNTANT" as string,
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Thomas" } as never,
  currency: "SAR",
};

vi.mock("@/lib/appContext", () => ({
  loadAppContext: vi.fn(async () => ctx),
  requirePermission: vi.fn(),
}));

const globalSearch = vi.hoisted(() => vi.fn(async () => ({
  products: [{ id: "p1", sku: "bowl-large-016", nameAr: "وعاء كبير", nameEn: "Large bowl", status: "ACTIVE" }],
  orders: [{ id: "o1", salesOrderNumber: "SO-0003", status: "CONFIRMED", grandTotal: 25900, orderDate: new Date(0) }],
})));
vi.mock("@/services/search", () => ({ globalSearch }));

const can = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  can,
}));

const SearchPage = (await import("./page")).default;
const { requirePermission } = await import("@/lib/appContext");

const args = (q?: string) => ({
  params: Promise.resolve({ locale: "ar" }),
  searchParams: Promise.resolve(q === undefined ? {} : { q }),
});

describe("SearchPage", () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    globalSearch.mockClear();
    can.mockReturnValue(true);
  });

  it("gates on dashboard.view, which every role holds", async () => {
    await SearchPage(args("bowl"));
    expect(requirePermission).toHaveBeenCalledWith(ctx, "dashboard.view", "ar");
  });

  it("passes the query through and hands both sections to the results", async () => {
    const tree = await SearchPage(args("bowl"));
    const [results] = collectByType(tree, SearchResults);

    expect(globalSearch).toHaveBeenCalledWith("c1", "bowl");
    expect((results!.props! as { products: unknown[] }).products).toHaveLength(1);
    expect((results!.props! as { orders: unknown[] }).orders).toHaveLength(1);
  });

  it("does not search at all until something is typed", async () => {
    await SearchPage(args());
    // A blank query searched server-side is a full-catalogue read nobody asked
    // for, on every visit to the page.
    expect(globalSearch).not.toHaveBeenCalled();
  });

  it("nulls the orders section for a role without sales.view", async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== "sales.view");
    const tree = await SearchPage(args("SO-"));
    const [results] = collectByType(tree, SearchResults);

    // Null, not empty: the component renders nothing for a section the role
    // may not see, and the rows never reach the RSC payload.
    expect((results!.props! as { orders: unknown }).orders).toBeNull();
    expect((results!.props! as { products: unknown[] }).products).toHaveLength(1);
  });

  it("skips the query entirely when no section may be shown", async () => {
    can.mockImplementation((...a: unknown[]) =>
      a[1] !== "sales.view" && a[1] !== "products.view");
    await SearchPage(args("bowl"));

    expect(globalSearch).not.toHaveBeenCalled();
  });
});

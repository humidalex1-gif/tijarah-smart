import { describe, it, expect, vi, beforeEach } from "vitest";

// Structural walk of the returned element tree, same technique as
// src/app/[locale]/(app)/page.test.ts and .../counts/page.test.ts — this is
// an async Server Component invoked directly, so its return value is a
// plain element graph, never rendered through react-dom.

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

// CountEntryForm imports the real "../actions" module (recordCountAction /
// submitForReviewAction), which imports "@/lib/action" -> "@/lib/auth" ->
// next-auth at module scope — same reason every actions.test.ts in this repo
// mocks "@/lib/auth" rather than letting the real NextAuth config load under
// vitest. This test never calls either action (that is CountEntryForm's own
// test's job), so a bare unimplemented mock is enough.
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));

// One line, snapshotQty = 41 000 (41 units in thousandths). 41 is chosen to
// be a value that appears nowhere else in the fixture. Product name and SKU
// deliberately contain no digits, so a false pass can't hide behind an
// unrelated digit collision.
//
// This mock does not enforce Prisma's `select` the way the real query engine
// does — a stub that returned exactly the selected fields would only prove
// the fixture matches the query, not that the PAGE never reads
// `.snapshotQty` off a row. Returning it here anyway means the guard test
// below only passes if the page itself never touches that field when
// building CountEntryForm's props — the actual discipline this task exists
// to enforce (see brief step 5, mirrored in the discrimination test below).
const baseSession = {
  id: "s1",
  companyId: "c1",
  countNumber: "CNT-ONE",
  status: "OPEN",
  warehouse: { name: "Main Warehouse" },
  lines: [
    {
      id: "line1",
      countedQty: null,
      recountRequested: false,
      variantId: null,
      product: { nameAr: "منتج ألفا", nameEn: "Product Alpha", sku: "SKU-ALPHA" },
      snapshotQty: 41000,
    },
  ],
};

vi.mock("@/lib/db", () => ({
  prisma: {
    stockCountSession: {
      findFirst: vi.fn(async () => baseSession),
    },
    // Finding 1: variant identity is joined from a second, batched,
    // tenant-scoped query (StockCountLine has no `variant` relation in the
    // schema). Defaults to empty — baseSession's one line has variantId:
    // null, so the page never calls this for the existing tests; the
    // variant-identity tests below override it and assert the call shape.
    productVariant: {
      findMany: vi.fn(async () => []),
    },
  },
}));

const CountPage = (await import("./page")).default;
const { requirePermission } = await import("@/lib/appContext");
const { prisma } = await import("@/lib/db");
const { CountEntryForm } = await import("./CountEntryForm");

const args = {
  params: Promise.resolve({ locale: "en", id: "s1" }),
};

// Finding 1 (whole-branch review): duplicated from
// .../counts/[id]/review/page.test.ts rather than lifted into a shared
// helper — with only two call sites in the whole suite, a shared test-utils
// module would be more machinery than the problem needs, and every
// page.test.ts in this codebase already stands alone (see the
// "Structural walk" comment at the top of this file).
//
// Finds the first element in the returned tree matching `predicate`,
// recursing through `.props.children` (array, single element, or neither).
// Robust to wrapper <div>s the page adds around CountEntryForm — unlike
// indexing `result.props.children[N]`, it never breaks when the surrounding
// layout changes.
function findElement(node: unknown, predicate: (n: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  const n = node as any;
  if (predicate(n)) return n;
  const children = n.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (children && typeof children === "object") {
    return findElement(children, predicate);
  }
  return undefined;
}

describe("CountEntryPage", () => {
  beforeEach(() => {
    ctx.role = "WAREHOUSE_MANAGER";
    vi.mocked(requirePermission).mockReset();
    vi.mocked(prisma.stockCountSession.findFirst).mockReset();
    vi.mocked(prisma.productVariant.findMany).mockReset();
    // `as never`, same as counts/actions.test.ts's mockRole: the fixture
    // deliberately carries `snapshotQty` (see comment above), which the real
    // Prisma client's select-narrowed return type does not have, so a
    // structurally-typed assignment here would fight the guard this test
    // exists to prove.
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(baseSession as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([] as never);
  });

  // Blind counting is enforced at CONSTRUCTION time, not with CSS. A value
  // computed into a client component's props ships in the RSC payload
  // whether or not it renders, exactly as cost and profit do (HANDOFF rule
  // 3). This test serialises the whole returned tree and asserts the
  // snapshot value is nowhere in it.
  it("never ships the expected quantity to the counting screen", async () => {
    const result = await CountPage(args);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("41000");
    expect(serialised).not.toContain("snapshotQty");
    // `not.toContain("41000")` alone would miss a narrower leak: a page that
    // ran the value through fromQty (41000 thousandths -> 41 units) before
    // handing it to CountEntryForm would still be leaking the snapshot, just
    // scaled down, and the literal check above would not catch it. The
    // fixture's product name and SKU contain no digits, so this assertion
    // can never pass by coincidence.
    expect(serialised).not.toContain("41");
  });

  it("gates the page through requirePermission for inventory.count, before loading any data", async () => {
    await CountPage(args);

    expect(requirePermission).toHaveBeenCalledWith(ctx, "inventory.count", "en");
  });

  it("scopes the session lookup to the current company, not the id alone", async () => {
    await CountPage(args);

    expect(prisma.stockCountSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1", companyId: "c1" } }),
    );
  });

  // Finding 4: the discrimination test above only proves snapshotQty never
  // reaches CountEntryForm's PROPS. A mock that returned exactly the
  // selected fields would also make that test pass if `snapshotQty: true`
  // were re-added to the `select` and simply never mapped — the props-level
  // assertion alone can't see that regression until it becomes a real leak.
  // This asserts the STRUCTURAL half directly: the query itself never asks
  // for the field.
  it("never re-adds snapshotQty to the lines select, not just to props", async () => {
    await CountPage(args);

    expect(prisma.stockCountSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          lines: expect.objectContaining({
            select: expect.not.objectContaining({ snapshotQty: true }),
          }),
        }),
      }),
    );
  });

  // Finding 7: an explicit `select` for the session itself (not `include`,
  // which would pull every scalar StockCountSession has, including any
  // added later) — narrowed to exactly the four fields this page reads.
  it("narrows the session query to an explicit select, not an unbounded include", async () => {
    await CountPage(args);

    const call = vi.mocked(prisma.stockCountSession.findFirst).mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("include");
    expect(call.select).toEqual(
      expect.objectContaining({ id: true, countNumber: true, status: true }),
    );
  });

  // Finding 6: createStockCount (stockCount.ts) creates one StockCountLine
  // per variant, so every line of a multi-variant product ties on
  // `product.sku`. Without a secondary sort, router.refresh() (called after
  // every row save in CountEntryForm) could reshuffle those tied rows
  // mid-count — `id` is stable across refreshes, `product.sku` alone is not.
  it("breaks ties in the lines' sort order with a stable secondary key", async () => {
    await CountPage(args);

    expect(prisma.stockCountSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          lines: expect.objectContaining({
            orderBy: [{ product: { sku: "asc" } }, { id: "asc" }],
          }),
        }),
      }),
    );
  });

  it("404s for a session that does not exist (or belongs to another company) rather than leaking which", async () => {
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(null as never);

    await expect(CountPage(args)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("redirects to the review screen for a session that is no longer OPEN, instead of rendering a dead counting form", async () => {
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue({
      ...baseSession,
      status: "REVIEW",
    } as never);

    await expect(CountPage(args)).rejects.toMatchObject({
      digest: expect.stringContaining("/en/inventory/counts/s1/review"),
    });
  });
});

// Finding 1: createStockCount (stockCount.ts) makes one StockCountLine per
// VARIANT, so a two-size shirt produces two lines sharing the same
// product.nameEn/nameAr/sku. The page selected `variantId` but never used
// it, so both rows rendered with identical product name and SKU — a
// counter filling them in had no way to tell which was which, and a wrong
// fill posts a real, wrong delta to the wrong variant's stock.
describe("CountEntryPage variant identity", () => {
  const variantSession = {
    id: "s2",
    companyId: "c1",
    countNumber: "CNT-TWO",
    status: "OPEN",
    warehouse: { name: "Main Warehouse" },
    lines: [
      {
        id: "line-v1", countedQty: null, recountRequested: false, variantId: "v1",
        product: { nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT" },
      },
      {
        id: "line-v2", countedQty: null, recountRequested: false, variantId: "v2",
        product: { nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT" },
      },
    ],
  };
  const variantArgs = { params: Promise.resolve({ locale: "en", id: "s2" }) };

  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    vi.mocked(prisma.stockCountSession.findFirst).mockReset();
    vi.mocked(prisma.productVariant.findMany).mockReset();
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(variantSession as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([
      { id: "v1", name: "Red / M", sku: "SHIRT-RED-M" },
      { id: "v2", name: "Red / L", sku: "SHIRT-RED-L" },
    ] as never);
  });

  it("loads variant identities in ONE batched, tenant-scoped query, keyed on every distinct variantId the lines carry", async () => {
    await CountPage(variantArgs);

    expect(prisma.productVariant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productVariant.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, companyId: "c1" },
      select: { id: true, name: true, sku: true },
    });
  });

  it("renders two variant lines of the same product distinguishably, preferring the variant's own SKU", async () => {
    const result = await CountPage(variantArgs);

    // findElement (defined above) walks the returned tree structurally
    // instead of indexing children[2] — the previous version broke the
    // moment an element was inserted between the <p> and <CountEntryForm> in
    // page.tsx.
    const formElement = findElement(result, (n) => n.type === CountEntryForm);
    const lines = formElement.props.lines as Array<{ productName: string; variantName: string | null; sku: string }>;

    expect(lines[0].productName).toBe(lines[1].productName);
    // The actual regression: before this fix, both rows also shared
    // identical variantName/sku, making them indistinguishable to the
    // counter. This is the tell that they no longer do.
    expect(lines[0].variantName).toBe("Red / M");
    expect(lines[1].variantName).toBe("Red / L");
    expect(lines[0].sku).toBe("SHIRT-RED-M");
    expect(lines[1].sku).toBe("SHIRT-RED-L");
  });
});

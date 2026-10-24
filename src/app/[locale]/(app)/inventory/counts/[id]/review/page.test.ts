import { describe, it, expect, vi, beforeEach } from "vitest";

// Structural walk of the returned element tree, same technique as
// ../page.test.ts and ../../page.test.ts (the counting screen) — this is an
// async Server Component invoked directly, so its return value is a plain
// element graph. DataTable's `columns[].render(row)` closures are captured,
// not yet invoked, when the page function returns — calling them ourselves
// on a chosen fixture row lets us inspect exactly what a given cell renders
// without any DOM/react-dom dependency.

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

// The page calls can(ctx.role, "finance.view_cost") directly (not through
// requirePermission, which is mocked away above) to decide whether the
// variance-value column exists at all. Mocking this module lets the
// value-column tests control that independently of `role` — no fixed role in
// the PERMISSIONS table holds inventory.count_post without finance.view_cost
// (WAREHOUSE_MANAGER, the only non-"*" role with count_post, also holds
// finance.view_cost), so there is no real role that isolates the two.
vi.mock("@/lib/permissions", () => ({
  can: vi.fn(() => true),
}));

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));

// Seven lines, deliberately covering every combination of
// (counted/uncounted) x (variance zero/nonzero) x (drifted/not drifted), with
// three DISTINCT summary counts (movingCount=2, uncountedCount=1,
// driftedCount=3) so a bug that swapped which count feeds which placeholder
// cannot hide behind a coincidental equal count:
//
//   move1:      counted, variance -3 (moving), live matches snapshot
//   move2:      counted, variance +1 (moving), live matches snapshot
//   uncounted1: NOT counted, live matches snapshot
//   drift1/2/3: counted, variance 0 (NOT moving), live differs from snapshot
//   plain:      counted, variance 0, live matches snapshot — the boring row
//               nothing should flag
const baseSession = {
  id: "s1",
  companyId: "c1",
  countNumber: "CNT-0007",
  status: "REVIEW",
  warehouseId: "w1",
  warehouse: { name: "Main Warehouse" },
  lines: [
    {
      id: "line-move1", productId: "p-move1", variantId: null, variantKey: "",
      snapshotQty: 10000, countedQty: 7000, recountRequested: false,
      product: { nameAr: "نقل واحد", nameEn: "Move One", sku: "SKU-MOVE-1" },
    },
    {
      id: "line-move2", productId: "p-move2", variantId: null, variantKey: "",
      snapshotQty: 1000, countedQty: 2000, recountRequested: false,
      product: { nameAr: "نقل اثنان", nameEn: "Move Two", sku: "SKU-MOVE-2" },
    },
    {
      id: "line-uncounted1", productId: "p-uncounted1", variantId: null, variantKey: "",
      snapshotQty: 20000, countedQty: null, recountRequested: false,
      product: { nameAr: "غير معدود", nameEn: "Uncounted One", sku: "SKU-UNCOUNTED-1" },
    },
    {
      id: "line-drift1", productId: "p-drift1", variantId: null, variantKey: "",
      snapshotQty: 30000, countedQty: 30000, recountRequested: false,
      product: { nameAr: "تفاوت واحد", nameEn: "Drift One", sku: "SKU-DRIFT-1" },
    },
    {
      id: "line-drift2", productId: "p-drift2", variantId: null, variantKey: "",
      snapshotQty: 5000, countedQty: 5000, recountRequested: false,
      product: { nameAr: "تفاوت اثنان", nameEn: "Drift Two", sku: "SKU-DRIFT-2" },
    },
    {
      id: "line-drift3", productId: "p-drift3", variantId: null, variantKey: "",
      snapshotQty: 8000, countedQty: 8000, recountRequested: false,
      product: { nameAr: "تفاوت ثلاثة", nameEn: "Drift Three", sku: "SKU-DRIFT-3" },
    },
    {
      id: "line-plain", productId: "p-plain", variantId: null, variantKey: "",
      snapshotQty: 40000, countedQty: 40000, recountRequested: false,
      product: { nameAr: "عادي", nameEn: "Plain One", sku: "SKU-PLAIN-1" },
    },
  ],
};

const baseBalances = [
  { productId: "p-move1", variantKey: "", availableQty: 10000, avgCost: 50000 },
  { productId: "p-move2", variantKey: "", availableQty: 1000, avgCost: 20000 },
  { productId: "p-uncounted1", variantKey: "", availableQty: 20000, avgCost: 0 },
  { productId: "p-drift1", variantKey: "", availableQty: 25000, avgCost: 0 },
  { productId: "p-drift2", variantKey: "", availableQty: 6000, avgCost: 0 },
  { productId: "p-drift3", variantKey: "", availableQty: 9000, avgCost: 0 },
  { productId: "p-plain", variantKey: "", availableQty: 40000, avgCost: 0 },
];

vi.mock("@/lib/db", () => ({
  prisma: {
    stockCountSession: { findFirst: vi.fn(async () => baseSession) },
    productVariant: { findMany: vi.fn(async () => []) },
    inventoryBalance: { findMany: vi.fn(async () => baseBalances) },
  },
}));

const ReviewPage = (await import("./page")).default;
const { requirePermission } = await import("@/lib/appContext");
const { can } = await import("@/lib/permissions");
const { prisma } = await import("@/lib/db");
const { StatusBadge } = await import("@/components/ui/StatusBadge");
const { Money } = await import("@/components/ui/Money");
const { DataTable } = await import("@/components/ui/DataTable");
const { ReviewActions, RecountButton } = await import("./ReviewActions");
const { getTranslator } = await import("@/lib/i18n");
const { formatNumber } = await import("@/lib/format");

const args = { params: Promise.resolve({ locale: "en", id: "s1" }) };

// Finds the first element in the returned tree matching `predicate`,
// recursing through `.props.children` (array, single element, or neither).
// Robust to wrapper <div>s the page adds around DataTable/ReviewActions —
// unlike indexing `result.props.children[N]`, it never breaks when the
// surrounding layout changes.
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

function rowById(rows: Array<{ id: string }>, id: string) {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`fixture row ${id} not found`);
  return row;
}

describe("CountReviewPage", () => {
  beforeEach(() => {
    ctx.role = "WAREHOUSE_MANAGER";
    vi.mocked(requirePermission).mockReset();
    vi.mocked(can).mockReset();
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(prisma.stockCountSession.findFirst).mockReset();
    vi.mocked(prisma.productVariant.findMany).mockReset();
    vi.mocked(prisma.inventoryBalance.findMany).mockReset();
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(baseSession as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inventoryBalance.findMany).mockResolvedValue(baseBalances as never);
  });

  it("gates the page through requirePermission for inventory.count_post, not inventory.count", async () => {
    await ReviewPage(args);

    expect(requirePermission).toHaveBeenCalledWith(ctx, "inventory.count_post", "en");
    expect(requirePermission).not.toHaveBeenCalledWith(ctx, "inventory.count", "en");
  });

  it("scopes the session lookup to the current company, not the id alone", async () => {
    await ReviewPage(args);

    expect(prisma.stockCountSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1", companyId: "c1" } }),
    );
  });

  it("narrows the session query to an explicit select, not an unbounded include", async () => {
    await ReviewPage(args);

    const call = vi.mocked(prisma.stockCountSession.findFirst).mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("include");
    expect(call.select).toEqual(
      expect.objectContaining({ id: true, countNumber: true, status: true, warehouseId: true }),
    );
  });

  it("404s for a session that does not exist (or belongs to another company)", async () => {
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(null as never);

    await expect(ReviewPage(args)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("redirects an OPEN session back to the counting screen, the mirror image of that page's own redirect", async () => {
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue({
      ...baseSession,
      status: "OPEN",
    } as never);

    await expect(ReviewPage(args)).rejects.toMatchObject({
      digest: expect.stringContaining("/en/inventory/counts/s1"),
    });
  });

  it("shows an uncounted line as a distinct 'not counted' badge, never as a zero or a dash", async () => {
    const result = await ReviewPage(args);

    const table = findElement(result, (n) => n.type === DataTable);
    const countedColumn = table.props.columns.find((c: { key: string }) => c.key === "counted");
    const cell = countedColumn.render(rowById(table.props.rows, "line-uncounted1"));

    expect(cell.type).toBe(StatusBadge);
    expect(cell.props.label).toBe("Not counted");
    expect(cell.props.tone).toBe("neutral");

    // Discrimination: a COUNTED line's same column must be plain formatted
    // text, never the badge — proves the badge is conditioned on
    // countedQty === null, not rendered unconditionally.
    const countedCell = countedColumn.render(rowById(table.props.rows, "line-move1"));
    expect(typeof countedCell).toBe("string");
    expect(countedCell).toBe("7");
  });

  it("flags a drifted line (live balance != snapshot) even though its count matched what was expected", async () => {
    const result = await ReviewPage(args);

    const table = findElement(result, (n) => n.type === DataTable);
    const driftColumn = table.props.columns.find((c: { key: string }) => c.key === "drift");
    const row = rowById(table.props.rows, "line-drift1");

    // Ground truth from the fixture itself (not page.tsx's own computed
    // `variance` field, and not `row`, whose type here is only `{ id }`):
    // line-drift1 is countedQty(30000) === snapshotQty(30000), so its
    // variance is exactly zero, yet its live balance (25000) differs from
    // the snapshot, so it must still be flagged drifted. This is the exact
    // case that exposed Finding 1: driftedHint used to describe variance
    // ("the counted quantity differs"), which is a contradiction on a row
    // whose variance column reads zero.
    const fixtureLine = baseSession.lines.find((l) => l.id === "line-drift1")!;
    expect(fixtureLine.countedQty).not.toBeNull();
    expect(fixtureLine.countedQty! - fixtureLine.snapshotQty).toBe(0);

    const driftedCell = driftColumn.render(row);
    expect(driftedCell).not.toBeNull();
    const [badge, hint] = driftedCell.props.children;
    expect(badge.type).toBe(StatusBadge);
    expect(badge.props.label).toBe("Discrepancy");

    const t = await getTranslator("en");
    // Fetched from the dictionary rather than hardcoded here, so this test
    // enforces "whatever counts.driftedHint says gets rendered on a drifted
    // row" without freezing the exact wording in two places — but the
    // dictionary text itself is asserted not to repeat the variance
    // conflation Finding 1 found.
    expect(hint.props.children).toBe(t("counts.driftedHint"));
    expect(hint.props.children).not.toMatch(/counted quantity differs/i);
  });

  it("does NOT flag a line as drifted just because its variance is nonzero (live still matches snapshot)", async () => {
    const result = await ReviewPage(args);

    const table = findElement(result, (n) => n.type === DataTable);
    const driftColumn = table.props.columns.find((c: { key: string }) => c.key === "drift");

    // move1 has a real variance (-3) but its live balance (10000) equals its
    // snapshot (10000) — a naive `drifted = variance !== 0` implementation
    // would wrongly flag this row.
    expect(driftColumn.render(rowById(table.props.rows, "line-move1"))).toBeNull();
    // The fully-boring row: zero variance AND live matches snapshot.
    expect(driftColumn.render(rowById(table.props.rows, "line-plain"))).toBeNull();
  });

  it("shows the variance-value column, computed from the current avgCost, only when the role holds finance.view_cost", async () => {
    vi.mocked(can).mockReturnValue(true);
    const result = await ReviewPage(args);

    const table = findElement(result, (n) => n.type === DataTable);
    const valueColumn = table.props.columns.find((c: { key: string }) => c.key === "varianceValue");
    expect(valueColumn).toBeDefined();

    // move1: variance -3 (i.e. -3000 scaled) x avgCost 50000 (scaled) ->
    // costOf(-3000, 50000) = -15 minor units. Verified independently:
    // -3000 * 50000 / (1000 * 10000) = -15.
    const cell = valueColumn.render(rowById(table.props.rows, "line-move1"));
    expect(cell.type).toBe(Money);
    expect(cell.props.minor).toBe(-15);

    // An uncounted line has no variance to value.
    const uncountedCell = valueColumn.render(rowById(table.props.rows, "line-uncounted1"));
    expect(uncountedCell).toBe("—");
  });

  it("removes the variance-value column entirely (not merely hides it) for a role lacking finance.view_cost, while unit columns remain", async () => {
    vi.mocked(can).mockImplementation((_role: unknown, permission: string) => permission !== "finance.view_cost");
    const result = await ReviewPage(args);

    const table = findElement(result, (n) => n.type === DataTable);
    expect(table.props.columns.some((c: { key: string }) => c.key === "varianceValue")).toBe(false);
    // Units stay visible without the permission, matching the suppliers list.
    expect(table.props.columns.some((c: { key: string }) => c.key === "variance")).toBe(true);
    expect(table.props.columns.some((c: { key: string }) => c.key === "expected")).toBe(true);
    expect(table.props.columns.some((c: { key: string }) => c.key === "counted")).toBe(true);
  });

  it("renders ReviewActions only when the session is in REVIEW, and states the real posting impact with every placeholder filled", async () => {
    const result = await ReviewPage(args);

    const reviewActions = findElement(result, (n) => n.type === ReviewActions);
    expect(reviewActions).toBeDefined();

    const t = await getTranslator("en");
    // Independently derived from the fixture (not copied from page.tsx's own
    // computation): 2 lines have a nonzero variance (move1, move2) and will
    // move stock; 1 line was never counted (uncounted1); 3 lines drifted
    // (drift1/2/3). Distinct numbers so a swapped mapping cannot pass by
    // coincidence.
    const expectedMessage = t("counts.postConfirmMessage", {
      countNumber: "CNT-0007",
      warehouse: "Main Warehouse",
      movingCount: formatNumber(2, "en"),
      uncountedCount: formatNumber(1, "en"),
      driftedCount: formatNumber(3, "en"),
    });
    expect(reviewActions.props.labels.postConfirmMessage).toBe(expectedMessage);
    expect(reviewActions.props.labels.postConfirmMessage).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("does not render ReviewActions (or a recount trigger) once the count has been posted", async () => {
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue({
      ...baseSession,
      status: "POSTED",
    } as never);

    const result = await ReviewPage(args);

    expect(findElement(result, (n) => n.type === ReviewActions)).toBeUndefined();
    const table = findElement(result, (n) => n.type === DataTable);
    expect(table.props.columns.some((c: { key: string }) => c.key === "recount")).toBe(false);
  });

  it("offers a recount trigger per line while the session is in REVIEW", async () => {
    const result = await ReviewPage(args);

    const table = findElement(result, (n) => n.type === DataTable);
    const recountColumn = table.props.columns.find((c: { key: string }) => c.key === "recount");
    expect(recountColumn).toBeDefined();

    const cell = recountColumn.render(rowById(table.props.rows, "line-drift1"));
    expect(cell.type).toBe(RecountButton);
    expect(cell.props.lineId).toBe("line-drift1");
  });
});

// Mirrors the counting screen's own "variant identity" test: createStockCount
// makes one StockCountLine per VARIANT, so a two-size shirt produces two
// lines sharing the same product name/SKU. The review screen faces the same
// ambiguity and is explicitly allowed to look up variant identity — but only
// `{ id, name, sku }`, never a bare `include` that would ship the four price
// columns ProductVariant also carries.
describe("CountReviewPage variant identity", () => {
  const variantSession = {
    id: "s2",
    companyId: "c1",
    countNumber: "CNT-0008",
    status: "REVIEW",
    warehouseId: "w1",
    warehouse: { name: "Main Warehouse" },
    lines: [
      {
        id: "line-v1", productId: "p-shirt", variantId: "v1", variantKey: "v1",
        snapshotQty: 10000, countedQty: 10000, recountRequested: false,
        product: { nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT" },
      },
      {
        id: "line-v2", productId: "p-shirt", variantId: "v2", variantKey: "v2",
        snapshotQty: 5000, countedQty: 5000, recountRequested: false,
        product: { nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT" },
      },
    ],
  };
  const variantArgs = { params: Promise.resolve({ locale: "en", id: "s2" }) };

  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    vi.mocked(can).mockReset();
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(prisma.stockCountSession.findFirst).mockReset();
    vi.mocked(prisma.productVariant.findMany).mockReset();
    vi.mocked(prisma.inventoryBalance.findMany).mockReset();
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(variantSession as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([
      { id: "v1", name: "Red / M", sku: "SHIRT-RED-M" },
      { id: "v2", name: "Red / L", sku: "SHIRT-RED-L" },
    ] as never);
    vi.mocked(prisma.inventoryBalance.findMany).mockResolvedValue([
      { productId: "p-shirt", variantKey: "v1", availableQty: 10000, avgCost: 0 },
      { productId: "p-shirt", variantKey: "v2", availableQty: 5000, avgCost: 0 },
    ] as never);
  });

  it("loads variant identities in ONE batched, tenant-scoped query selecting only id/name/sku", async () => {
    await ReviewPage(variantArgs);

    expect(prisma.productVariant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productVariant.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, companyId: "c1" },
      select: { id: true, name: true, sku: true },
    });
  });

  it("renders two variant lines of the same product distinguishably", async () => {
    const result = await ReviewPage(variantArgs);

    const table = findElement(result, (n) => n.type === DataTable);
    const variantColumn = table.props.columns.find((c: { key: string }) => c.key === "variant");
    expect(variantColumn.render(rowById(table.props.rows, "line-v1"))).toBe("Red / M");
    expect(variantColumn.render(rowById(table.props.rows, "line-v2"))).toBe("Red / L");
  });
});

// Finding 3: recountRequested is selected from the session query but was
// never read anywhere on this page. Both fixture lines below are
// countedQty === null — indistinguishable by that field alone — but only one
// was actually flagged for a fresh count (requestRecount clears countedQty
// AND sets recountRequested; a line nobody has ever touched has
// countedQty === null with recountRequested still false). A reviewer needs
// to tell these apart: one is "never reached", the other is "flagged once,
// still not resolved".
describe("CountReviewPage recountRequested", () => {
  const recountSession = {
    id: "s3",
    companyId: "c1",
    countNumber: "CNT-0009",
    status: "REVIEW",
    warehouseId: "w1",
    warehouse: { name: "Main Warehouse" },
    lines: [
      {
        id: "line-flagged", productId: "p-flagged", variantId: null, variantKey: "",
        snapshotQty: 10000, countedQty: null, recountRequested: true,
        product: { nameAr: "مطلوب إعادة جرد", nameEn: "Flagged", sku: "SKU-FLAGGED" },
      },
      {
        id: "line-untouched", productId: "p-untouched", variantId: null, variantKey: "",
        snapshotQty: 10000, countedQty: null, recountRequested: false,
        product: { nameAr: "لم يُجرد", nameEn: "Untouched", sku: "SKU-UNTOUCHED" },
      },
    ],
  };
  const recountArgs = { params: Promise.resolve({ locale: "en", id: "s3" }) };

  beforeEach(() => {
    vi.mocked(requirePermission).mockReset();
    vi.mocked(can).mockReset();
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(prisma.stockCountSession.findFirst).mockReset();
    vi.mocked(prisma.productVariant.findMany).mockReset();
    vi.mocked(prisma.inventoryBalance.findMany).mockReset();
    vi.mocked(prisma.stockCountSession.findFirst).mockResolvedValue(recountSession as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inventoryBalance.findMany).mockResolvedValue([
      { productId: "p-flagged", variantKey: "", availableQty: 10000, avgCost: 0 },
      { productId: "p-untouched", variantKey: "", availableQty: 10000, avgCost: 0 },
    ] as never);
  });

  it("shows a distinct recount badge for a line already flagged, never the plain 'not counted' badge", async () => {
    const result = await ReviewPage(recountArgs);

    const table = findElement(result, (n) => n.type === DataTable);
    const countedColumn = table.props.columns.find((c: { key: string }) => c.key === "counted");
    const t = await getTranslator("en");

    const flaggedCell = countedColumn.render(rowById(table.props.rows, "line-flagged"));
    expect(flaggedCell.type).toBe(StatusBadge);
    expect(flaggedCell.props.label).toBe(t("counts.recount"));
    expect(flaggedCell.props.label).not.toBe(t("counts.notCounted"));

    // Discrimination: a line with the SAME countedQty === null but
    // recountRequested === false must still get the plain badge — proves the
    // recount badge is conditioned on recountRequested, not merely on an
    // uncounted line existing.
    const untouchedCell = countedColumn.render(rowById(table.props.rows, "line-untouched"));
    expect(untouchedCell.type).toBe(StatusBadge);
    expect(untouchedCell.props.label).toBe(t("counts.notCounted"));
  });
});

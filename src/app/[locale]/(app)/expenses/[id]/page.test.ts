import { describe, it, expect, vi, beforeEach } from "vitest";
import { Attachments } from "./Attachments";

/**
 * The owner can attach an invoice while creating an expense, and the file is
 * stored — but for a month the expense's own page never showed it. Both the
 * component and `listAttachments` were imported at the top of page.tsx and
 * used nowhere below. This is the guard the project's own history says it
 * needs: a finished feature that nothing on screen reaches is not shipped.
 *
 * Same structural walk as `quick/page.test.ts`: the async Server Component is
 * invoked directly and its element graph inspected without a DOM.
 */
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
  role: "OWNER" as string,
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Thomas" } as never,
  currency: "SAR",
};

const EXPENSE = {
  id: "e1", companyId: "c1", expenseNumber: "EXP-0007", status: "POSTED",
  expenseDate: new Date("2026-08-02T00:00:00.000Z"),
  amount: 22_000, taxAmount: 3_300, totalAmount: 25_300,
  description: "Fast Hub storage, July", notes: null, warehouseId: null,
  category: { nameAr: "شحن", nameEn: "Shipping" },
  account: { name: "Cash" },
  supplier: { name: "Fast Hub" },
};

const STORED = [
  { id: "att1", fileName: "fasthub-july.pdf", mimeType: "application/pdf", sizeBytes: 48_112 },
];

vi.mock("@/lib/appContext", () => ({
  loadAppContext: vi.fn(async () => ctx),
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    expense: { findFirst: vi.fn(async () => EXPENSE) },
    warehouse: { findFirst: vi.fn(async () => null) },
  },
}));

const listAttachments = vi.hoisted(() => vi.fn(async () => STORED));
vi.mock("@/lib/uploads", () => ({ listAttachments }));

// The two client components on this page reach their server actions through
// `action()`, which pulls in next-auth and cannot resolve outside a Next
// runtime. The page itself never calls them.
vi.mock("./actions", () => ({ attachToExpenseAction: vi.fn(), removeAttachmentAction: vi.fn() }));
vi.mock("../actions", () => ({ cancelExpenseAction: vi.fn() }));

const ExpensePage = (await import("./page")).default;

const args = { params: Promise.resolve({ locale: "ar", id: "e1" }) };

describe("ExpensePage documents", () => {
  beforeEach(() => {
    listAttachments.mockClear();
  });

  it("shows the documents attached to this expense, read for this expense", async () => {
    const tree = await ExpensePage(args);
    const [documents] = collectByType(tree, Attachments);

    expect(documents).toBeDefined();
    expect(documents!.props!.expenseId).toBe("e1");
    // What is on screen is what is stored, not an empty list the client then
    // has to discover — the list is read on the server for THIS expense.
    expect(documents!.props!.initial).toEqual(STORED);
    expect(listAttachments).toHaveBeenCalledWith(ctx, "EXPENSE", "e1");
  });
});

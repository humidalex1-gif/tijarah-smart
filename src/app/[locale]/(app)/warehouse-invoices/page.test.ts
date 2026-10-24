import { describe, it, expect, vi } from "vitest";
import { formatMoney } from "@/lib/format";
import { InvoiceUpload } from "./InvoiceUpload";

/**
 * The one screen where the owner compares Fast Hub's stated total against his
 * own books printed every figure as a bare number — the only money in the app
 * with no currency on it. Both the page and the upload panel had a local
 * `money` helper that divided by 100 and stopped.
 *
 * Same structural walk as `quick/page.test.ts`.
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
/** Every string in the graph, joined — the page's visible text, order aside. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out; }
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (!isElementLike(node)) return out;
  if (node.props?.children !== undefined) collectText(node.props.children, out);
  return out;
}

const ctx = {
  userId: "u1",
  companyId: "c1",
  role: "OWNER" as string,
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Thomas" } as never,
  currency: "SAR",
};

const INVOICE = {
  id: "inv1", companyId: "c1", invoiceNumber: "FH-2026-08",
  invoiceDate: new Date("2026-08-31T00:00:00.000Z"),
  total: 304_818, _count: { lines: 14 },
};

vi.mock("@/lib/appContext", () => ({
  loadAppContext: vi.fn(async () => ctx),
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    expenseCategory: { findMany: vi.fn(async () => [{ id: "cat1", nameAr: "تخزين", nameEn: "Storage" }]) },
    financialAccount: { findMany: vi.fn(async () => [{ id: "acc1", name: "Cash" }]) },
    warehouseInvoice: { findMany: vi.fn(async () => [INVOICE]) },
  },
}));

// The upload panel reaches its server actions through `action()`, which pulls
// in next-auth and cannot resolve outside a Next runtime.
vi.mock("./actions", () => ({ previewWarehouseInvoiceAction: vi.fn(), postWarehouseInvoiceAction: vi.fn() }));

const Page = (await import("./page")).default;
const args = { params: Promise.resolve({ locale: "ar" }) };

describe("WarehouseInvoicesPage money", () => {
  it("prints the invoice total as money, with the currency, not as a bare number", async () => {
    const tree = await Page(args);
    const text = collectText(tree).join(" ");
    expect(text).toContain(formatMoney(INVOICE.total, "ar", "SAR"));
  });

  it("hands the upload panel the currency, so its preview and totals can carry it too", async () => {
    const tree = await Page(args);
    const [upload] = collectByType(tree, InvoiceUpload);
    expect(upload).toBeDefined();
    expect(upload!.props!.currency).toBe("SAR");
  });
});

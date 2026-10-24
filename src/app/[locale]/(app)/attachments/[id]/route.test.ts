import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The one route whose whole job is serving the company's financial documents.
 *
 * It used to check session + company only — no permission at all — while the
 * screens SHOWING these files gate on expenses.view / payments.view. A role
 * whose screens hide an expense invoice could still download it with the id
 * from a shared link or browser history. The route now derives the required
 * permission from the attachment's own entityType.
 */

const ctx = {
  userId: "u1", companyId: "c1", role: "OWNER" as string,
  company: { id: "c1", currencyCode: "SAR", onboardingCompleted: true } as never,
  user: { id: "u1", fullName: "Thomas" } as never,
  currency: "SAR",
};

vi.mock("@/lib/appContext", () => ({ loadAppContext: vi.fn(async () => ctx) }));

const upload = vi.hoisted(() => ({
  entityType: "EXPENSE" as string,
}));
vi.mock("@/lib/uploads", () => ({
  readUpload: vi.fn(async () => ({
    bytes: Buffer.from("pdf"), fileName: "invoice.pdf",
    mimeType: "application/pdf", entityType: upload.entityType,
  })),
}));

const { GET } = await import("./route");

const call = () =>
  GET(new Request("http://x"), { params: Promise.resolve({ locale: "ar", id: "att-1" }) });

describe("attachment download route", () => {
  beforeEach(() => {
    ctx.role = "OWNER";
    upload.entityType = "EXPENSE";
  });

  it("serves the owner an expense document", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("refuses an expense document to a role whose screens hide expenses", async () => {
    // SALES_EMPLOYEE holds no expenses.view: every expense screen redirects
    // them, and the raw file must not be the one door left unlocked.
    ctx.role = "SALES_EMPLOYEE";
    expect((await call()).status).toBe(403);
  });

  it("refuses a payment receipt to a role without payments.view", async () => {
    upload.entityType = "PAYMENT";
    ctx.role = "VIEWER";
    expect((await call()).status).toBe(403);
  });

  it("refuses an attachment of an unknown entity type rather than guessing", async () => {
    // A new entity type added without a permission mapping must fail CLOSED:
    // an unmapped document is exactly the one nobody decided about.
    upload.entityType = "SOMETHING_NEW";
    ctx.role = "ACCOUNTANT";
    expect((await call()).status).toBe(403);
  });

  it("serves an accountant the expense document their screens already show", async () => {
    ctx.role = "ACCOUNTANT";
    expect((await call()).status).toBe(200);
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { withAttachment } from "@/lib/attachOnCreate";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

/**
 * The ordering is the whole point, and it is the opposite of the obvious one:
 * the file is validated and written BEFORE the record is created.
 *
 * The obvious order — create, then upload — hands the owner a saved expense
 * plus an error about a document they can no longer attach from that screen.
 */

const DIR = path.join(process.cwd(), "data", "attach-test");
process.env.UPLOAD_DIR = DIR;

const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const file = (type = xlsx) => new File(["bytes"], "invoice.xlsx", { type });

afterAll(() => rm(DIR, { recursive: true, force: true }));

describe("withAttachment", () => {
  beforeEach(async () => {
    await resetDb();
    await rm(DIR, { recursive: true, force: true });
  });

  it("joins the document to the record it was uploaded with", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    const result = await withAttachment(ctx, {
      file: file(),
      entityType: "EXPENSE",
      create: async () => ({ id: "expense-1" }),
    });

    expect(result.attachmentId).toBeDefined();
    const row = await prisma.attachment.findFirstOrThrow();
    expect(row.entityType).toBe("EXPENSE");
    expect(row.entityId).toBe("expense-1");
  });

  it("rejects a bad file BEFORE the record exists", async () => {
    // If the order were reversed the owner would end up with a saved expense
    // and an error about a document, on a screen that has already navigated on.
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    let created = false;

    await expect(withAttachment(ctx, {
      file: file("text/html"),
      entityType: "EXPENSE",
      create: async () => { created = true; return { id: "expense-1" }; },
    })).rejects.toThrow();

    expect(created).toBe(false);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("leaves no orphan when the record itself fails to save", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    await expect(withAttachment(ctx, {
      file: file(),
      entityType: "EXPENSE",
      create: async () => { throw new Error("insufficient funds"); },
    })).rejects.toThrow("insufficient funds");

    expect(await prisma.attachment.count()).toBe(0);
    expect(await readdir(DIR)).toHaveLength(0);
  });

  it("creates the record untouched when no document was chosen", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    const result = await withAttachment(ctx, {
      file: undefined,
      entityType: "PAYMENT",
      create: async () => ({ id: "payment-1", paymentNumber: "PAY-1" }),
    });

    expect(result.paymentNumber).toBe("PAY-1");
    expect(result.attachmentId).toBeUndefined();
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("treats an empty file as no file, rather than failing the save", async () => {
    // Some browsers submit a zero-byte File for an untouched input. Refusing
    // the whole expense over it would be absurd.
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    const result = await withAttachment(ctx, {
      file: new File([], "", { type: "" }),
      entityType: "EXPENSE",
      create: async () => ({ id: "expense-1" }),
    });

    expect(result.id).toBe("expense-1");
    expect(await prisma.attachment.count()).toBe(0);
  });
});

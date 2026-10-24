import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { saveUpload, readUpload, listAttachments, deleteUpload } from "@/lib/uploads";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

/**
 * The stored name is the security boundary here: it is generated, never taken
 * from the upload. A filename is attacker input, and this suite exists mostly
 * to prove that a hostile one cannot reach outside the uploads directory.
 */

const DIR = path.join(process.cwd(), "data", "uploads-test");
process.env.UPLOAD_DIR = DIR;

const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const file = (name: string, type = xlsx, body = "content") =>
  new File([body], name, { type });

afterAll(() => rm(DIR, { recursive: true, force: true }));

describe("uploads", () => {
  beforeEach(async () => {
    await resetDb();
    await rm(DIR, { recursive: true, force: true });
  });

  it("stores the bytes and hands back what the owner named it", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    const saved = await saveUpload(ctx, {
      file: file("فاتورة يوليو.xlsx"), entityType: "WAREHOUSE_INVOICE", entityId: "inv-1",
    });

    expect(saved.fileName).toBe("فاتورة يوليو.xlsx");
    const read = await readUpload(ctx, saved.id);
    expect(read.bytes.toString()).toBe("content");
  });

  it("never writes the uploaded name to disk", async () => {
    // "../../.env" as a filename would otherwise land outside the uploads
    // directory entirely, or overwrite a file already in it.
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    await saveUpload(ctx, {
      file: file("../../.env"), entityType: "EXPENSE", entityId: "e-1",
    });

    const onDisk = await readdir(DIR);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatch(/^[0-9a-f-]{36}\.xlsx$/);
    expect(onDisk[0]).not.toContain("env");
    // The display name is stripped of its path too, so nothing downstream can
    // read it as one.
    const row = await prisma.attachment.findFirstOrThrow();
    expect(row.fileName).toBe(".env");
  });

  it("refuses a type it will not serve back", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    await expect(saveUpload(ctx, {
      file: file("payload.html", "text/html"), entityType: "EXPENSE", entityId: "e-1",
    })).rejects.toThrow();
  });

  it("refuses an empty file instead of storing nothing under a real row", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    await expect(saveUpload(ctx, {
      file: new File([], "empty.pdf", { type: "application/pdf" }),
      entityType: "EXPENSE", entityId: "e-1",
    })).rejects.toThrow();
  });

  it("does not hand one company's document to another", async () => {
    const mine = await makeCompany("Mine");
    const theirs = await makeCompany("Theirs");
    const saved = await saveUpload(makeCtx(theirs.id), {
      file: file("theirs.xlsx"), entityType: "EXPENSE", entityId: "e-1",
    });

    await expect(readUpload(makeCtx(mine.id), saved.id)).rejects.toThrow();
    expect(await listAttachments(makeCtx(mine.id), "EXPENSE", "e-1")).toEqual([]);
  });

  it("removes the row and the bytes together", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const saved = await saveUpload(ctx, {
      file: file("gone.xlsx"), entityType: "EXPENSE", entityId: "e-1",
    });

    await deleteUpload(ctx, saved.id);

    expect(await readdir(DIR)).toHaveLength(0);
    expect(await prisma.attachment.count()).toBe(0);
  });
});

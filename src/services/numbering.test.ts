import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { nextNumber } from "@/services/numbering";
import { makeCompany, resetDb } from "../../tests/factories";

describe("nextNumber", () => {
  beforeEach(resetDb);

  it("starts at 0001 and increments per prefix", async () => {
    const company = await makeCompany();
    expect(await nextNumber(prisma, company.id, "PO")).toBe("PO-0001");
    expect(await nextNumber(prisma, company.id, "PO")).toBe("PO-0002");
    expect(await nextNumber(prisma, company.id, "SO")).toBe("SO-0001");
  });

  it("keeps sequences separate per company", async () => {
    const a = await makeCompany("A Co");
    const b = await makeCompany("B Co");
    await nextNumber(prisma, a.id, "PO");
    await nextNumber(prisma, a.id, "PO");
    expect(await nextNumber(prisma, b.id, "PO")).toBe("PO-0001");
  });

  it("pads to at least four digits and grows beyond", async () => {
    const company = await makeCompany();
    await prisma.numberSequence.create({
      data: { companyId: company.id, prefix: "SO", nextValue: 10_000 },
    });
    expect(await nextNumber(prisma, company.id, "SO")).toBe("SO-10000");
  });
});

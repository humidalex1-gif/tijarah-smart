import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/services/audit";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

describe("writeAudit", () => {
  beforeEach(resetDb);

  it("stores the action with serialized old and new values", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);

    await writeAudit(prisma, ctx, {
      action: "PRODUCT_UPDATED",
      entityType: "Product",
      entityId: "p1",
      oldValues: { sellingPrice: 1000 },
      newValues: { sellingPrice: 1200 },
    });

    const log = await prisma.auditLog.findFirstOrThrow();
    expect(log.action).toBe("PRODUCT_UPDATED");
    expect(log.entityType).toBe("Product");
    expect(log.companyId).toBe(company.id);
    expect(JSON.parse(log.oldValues!)).toEqual({ sellingPrice: 1000 });
    expect(JSON.parse(log.newValues!)).toEqual({ sellingPrice: 1200 });
  });

  it("omits values when none are supplied", async () => {
    const company = await makeCompany();
    await writeAudit(prisma, makeCtx(company.id), {
      action: "SALE_CONFIRMED",
      entityType: "SalesOrder",
      entityId: "s1",
    });
    const log = await prisma.auditLog.findFirstOrThrow();
    expect(log.oldValues).toBeNull();
    expect(log.newValues).toBeNull();
  });
});

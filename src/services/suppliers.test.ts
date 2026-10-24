import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { createSupplier, updateSupplier } from "@/services/suppliers";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

describe("createSupplier", () => {
  beforeEach(resetDb);

  it("assigns the caller's company and audits the creation", async () => {
    const company = await makeCompany();
    const supplier = await createSupplier(makeCtx(company.id), {
      name: "Shenzhen Global Trading", country: "CN",
    });

    expect(supplier.companyId).toBe(company.id);
    expect(supplier.status).toBe("ACTIVE");
    expect(supplier.country).toBe("CN");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "SUPPLIER_CREATED" } });
    expect(log.entityType).toBe("Supplier");
    expect(log.entityId).toBe(supplier.id);
  });

  it("rejects a blank name", async () => {
    const company = await makeCompany();
    await expect(
      createSupplier(makeCtx(company.id), { name: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("rejects negative payment terms", async () => {
    const company = await makeCompany();
    await expect(
      createSupplier(makeCtx(company.id), { name: "A", paymentTermsDays: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_TERMS" });
  });

  it("allows the same name in a different company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    await createSupplier(makeCtx(companyA.id), { name: "Shared" });

    await expect(
      createSupplier(makeCtx(companyB.id), { name: "Shared" }),
    ).resolves.toBeDefined();
  });
});

describe("updateSupplier", () => {
  beforeEach(resetDb);

  it("records old and new values in the audit log", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const supplier = await createSupplier(ctx, { name: "Old Name", phone: "1" });

    await updateSupplier(ctx, supplier.id, { name: "New Name", phone: "2" });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "SUPPLIER_UPDATED" } });
    const oldValues = JSON.parse(log.oldValues!);
    const newValues = JSON.parse(log.newValues!);
    expect(oldValues.name).toBe("Old Name");
    expect(newValues.name).toBe("New Name");

    const updated = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
    expect(updated.name).toBe("New Name");
    expect(updated.phone).toBe("2");
  });

  it("cannot update a supplier belonging to another company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const supplier = await createSupplier(makeCtx(companyA.id), { name: "A" });

    await expect(
      updateSupplier(makeCtx(companyB.id), supplier.id, { name: "Hijacked" }),
    ).rejects.toThrow();
  });

  it("rejects renaming to a blank name", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const supplier = await createSupplier(ctx, { name: "A" });

    await expect(
      updateSupplier(ctx, supplier.id, { name: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });
});

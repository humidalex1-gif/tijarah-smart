import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { createWarehouse, updateWarehouse } from "@/services/warehouses";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

describe("createWarehouse", () => {
  beforeEach(resetDb);

  it("creates a warehouse under the caller's company and audits it", async () => {
    const company = await makeCompany();
    const warehouse = await createWarehouse(makeCtx(company.id), {
      name: "Jeddah Branch", code: "JED", city: "Jeddah",
    });

    expect(warehouse.companyId).toBe(company.id);
    const stored = await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouse.id } });
    expect(stored.name).toBe("Jeddah Branch");
    expect(stored.city).toBe("Jeddah");
    expect(stored.isDefault).toBe(false);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "WAREHOUSE_CREATED" } });
    expect(log.entityType).toBe("Warehouse");
    expect(log.entityId).toBe(warehouse.id);
  });

  it("rejects a same-company code clash", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createWarehouse(ctx, { name: "Main", code: "MAIN" });

    await expect(
      createWarehouse(ctx, { name: "Second Main", code: "MAIN" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_WAREHOUSE_CODE" });
  });

  it("allows the same code in a different company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    await createWarehouse(makeCtx(companyA.id), { name: "Main", code: "MAIN" });

    await expect(
      createWarehouse(makeCtx(companyB.id), { name: "Main", code: "MAIN" }),
    ).resolves.toBeDefined();
  });

  it("unsets the previous default when a new warehouse is created as default", async () => {
    // prisma/seed.ts and Tasks 7-9 all assume "the default warehouse"
    // (singular) — two `isDefault: true` rows would make any
    // `findFirstOrThrow({ isDefault: true })` caller nondeterministic.
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const first = await createWarehouse(ctx, { name: "Main", code: "MAIN", isDefault: true });

    const second = await createWarehouse(ctx, { name: "Branch", code: "BR", isDefault: true });

    const reloadedFirst = await prisma.warehouse.findUniqueOrThrow({ where: { id: first.id } });
    const reloadedSecond = await prisma.warehouse.findUniqueOrThrow({ where: { id: second.id } });
    expect(reloadedFirst.isDefault).toBe(false);
    expect(reloadedSecond.isDefault).toBe(true);
  });

  it("does not touch another company's default warehouse", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const warehouseA = await createWarehouse(makeCtx(companyA.id), { name: "Main", code: "MAIN", isDefault: true });

    await createWarehouse(makeCtx(companyB.id), { name: "Main", code: "MAIN", isDefault: true });

    const reloadedA = await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseA.id } });
    expect(reloadedA.isDefault).toBe(true);
  });
});

describe("updateWarehouse", () => {
  beforeEach(resetDb);

  it("updates fields and audits the old/new values", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const warehouse = await createWarehouse(ctx, { name: "Main", code: "MAIN", city: "Riyadh" });

    const updated = await updateWarehouse(ctx, warehouse.id, { name: "Main Warehouse", city: "Jeddah" });
    expect(updated.name).toBe("Main Warehouse");
    expect(updated.city).toBe("Jeddah");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "WAREHOUSE_UPDATED" } });
    expect(JSON.parse(log.oldValues!)).toMatchObject({ name: "Main", city: "Riyadh" });
    expect(JSON.parse(log.newValues!)).toMatchObject({ name: "Main Warehouse", city: "Jeddah" });
  });

  it("rejects a duplicate code from another warehouse in the same company", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createWarehouse(ctx, { name: "Main", code: "MAIN" });
    const second = await createWarehouse(ctx, { name: "Branch", code: "BR" });

    await expect(
      updateWarehouse(ctx, second.id, { code: "MAIN" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_WAREHOUSE_CODE" });
  });

  it("allows keeping its own code unchanged", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const warehouse = await createWarehouse(ctx, { name: "Main", code: "MAIN" });

    await expect(
      updateWarehouse(ctx, warehouse.id, { code: "MAIN", name: "Main Store" }),
    ).resolves.toBeDefined();
  });

  it("rejects a cross-company update as not found", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const warehouse = await createWarehouse(makeCtx(companyA.id), { name: "Main", code: "MAIN" });

    await expect(
      updateWarehouse(makeCtx(companyB.id), warehouse.id, { name: "Hijacked" }),
    ).rejects.toThrow();
  });

  it("writes no audit row when nothing actually changed", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const warehouse = await createWarehouse(ctx, { name: "Main", code: "MAIN" });

    await updateWarehouse(ctx, warehouse.id, { name: "Main" });
    expect(await prisma.auditLog.count({ where: { action: "WAREHOUSE_UPDATED" } })).toBe(0);
  });

  it("unsets the previous default when another warehouse is updated to become default", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const main = await createWarehouse(ctx, { name: "Main", code: "MAIN", isDefault: true });
    const branch = await createWarehouse(ctx, { name: "Branch", code: "BR" });

    await updateWarehouse(ctx, branch.id, { isDefault: true });

    const reloadedMain = await prisma.warehouse.findUniqueOrThrow({ where: { id: main.id } });
    const reloadedBranch = await prisma.warehouse.findUniqueOrThrow({ where: { id: branch.id } });
    expect(reloadedMain.isDefault).toBe(false);
    expect(reloadedBranch.isDefault).toBe(true);
  });

  it("rejects unchecking the sole default warehouse, leaving it unchanged", async () => {
    // WarehouseForm's checkbox preprocesses to `isDefault: false` on every
    // unchecked submit, so editing the only default warehouse with the box
    // left unchecked reaches here as an explicit `false`. Unsetting it would
    // leave the company with NO default, and prisma/seed.ts's
    // `findFirstOrThrow({ isDefault: true })` would throw.
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const main = await createWarehouse(ctx, { name: "Main", code: "MAIN", isDefault: true });

    await expect(
      updateWarehouse(ctx, main.id, { isDefault: false, name: "Main Store" }),
    ).rejects.toMatchObject({ code: "LAST_DEFAULT_WAREHOUSE" });

    // Unchanged — neither the isDefault flag nor (since the whole write was
    // rejected before any update ran) the name it was bundled with.
    const reloaded = await prisma.warehouse.findUniqueOrThrow({ where: { id: main.id } });
    expect(reloaded.isDefault).toBe(true);
    expect(reloaded.name).toBe("Main");
  });

  it("allows unchecking default on a warehouse when another is already default", async () => {
    // Self-heal case: if bad data somehow left two warehouses `isDefault:
    // true` (pre-fix write, manual DB edit), unsetting one must still be
    // allowed since it does not leave the company with zero.
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const main = await createWarehouse(ctx, { name: "Main", code: "MAIN", isDefault: true });
    await prisma.warehouse.create({
      data: { companyId: company.id, name: "Branch", code: "BR", isDefault: true },
    });

    await expect(
      updateWarehouse(ctx, main.id, { isDefault: false }),
    ).resolves.toBeDefined();

    const reloadedMain = await prisma.warehouse.findUniqueOrThrow({ where: { id: main.id } });
    expect(reloadedMain.isDefault).toBe(false);
  });

  it("allows unchecking default when the warehouse was already not the default", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    await createWarehouse(ctx, { name: "Main", code: "MAIN", isDefault: true });
    const branch = await createWarehouse(ctx, { name: "Branch", code: "BR" });

    // Already false -> false is a no-op, not "the last default" — must not
    // be rejected.
    await expect(
      updateWarehouse(ctx, branch.id, { isDefault: false, city: "Jeddah" }),
    ).resolves.toBeDefined();
  });
});

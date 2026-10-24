import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { createCustomer, updateCustomer } from "@/services/customers";
import { makeCompany, makeCtx, resetDb } from "../../tests/factories";

describe("createCustomer", () => {
  beforeEach(resetDb);

  it("assigns the caller's company, defaults customerType/status, and audits the creation", async () => {
    const company = await makeCompany();
    const customer = await createCustomer(makeCtx(company.id), { name: "Ahmed Al-Otaibi" });

    expect(customer.companyId).toBe(company.id);
    expect(customer.customerType).toBe("RETAIL");
    expect(customer.status).toBe("ACTIVE");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "CUSTOMER_CREATED" } });
    expect(log.entityType).toBe("Customer");
    expect(log.entityId).toBe(customer.id);
  });

  it("accepts an explicit WHOLESALE customerType", async () => {
    const company = await makeCompany();
    const customer = await createCustomer(makeCtx(company.id), {
      name: "Gulf Electronics LLC", customerType: "WHOLESALE",
    });
    expect(customer.customerType).toBe("WHOLESALE");
  });

  it("rejects a blank name", async () => {
    const company = await makeCompany();
    await expect(
      createCustomer(makeCtx(company.id), { name: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("rejects an unrecognized customerType", async () => {
    const company = await makeCompany();
    await expect(
      createCustomer(makeCtx(company.id), { name: "A", customerType: "VIP" }),
    ).rejects.toMatchObject({ code: "INVALID_CUSTOMER_TYPE" });
  });

  it("rejects negative payment terms", async () => {
    const company = await makeCompany();
    await expect(
      createCustomer(makeCtx(company.id), { name: "A", paymentTermsDays: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_TERMS" });
  });

  it("rejects a negative credit limit", async () => {
    const company = await makeCompany();
    await expect(
      createCustomer(makeCtx(company.id), { name: "A", creditLimit: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_CREDIT_LIMIT" });
  });

  it("allows the same name in a different company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    await createCustomer(makeCtx(companyA.id), { name: "Shared" });

    await expect(
      createCustomer(makeCtx(companyB.id), { name: "Shared" }),
    ).resolves.toBeDefined();
  });
});

describe("updateCustomer", () => {
  beforeEach(resetDb);

  it("records old and new values in the audit log", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const customer = await createCustomer(ctx, { name: "Old Name", phone: "1" });

    await updateCustomer(ctx, customer.id, { name: "New Name", phone: "2" });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "CUSTOMER_UPDATED" } });
    const oldValues = JSON.parse(log.oldValues!);
    const newValues = JSON.parse(log.newValues!);
    expect(oldValues.name).toBe("Old Name");
    expect(newValues.name).toBe("New Name");

    const updated = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(updated.name).toBe("New Name");
    expect(updated.phone).toBe("2");
  });

  it("cannot update a customer belonging to another company", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const customer = await createCustomer(makeCtx(companyA.id), { name: "A" });

    await expect(
      updateCustomer(makeCtx(companyB.id), customer.id, { name: "Hijacked" }),
    ).rejects.toThrow();
  });

  it("rejects renaming to a blank name", async () => {
    const company = await makeCompany();
    const ctx = makeCtx(company.id);
    const customer = await createCustomer(ctx, { name: "A" });

    await expect(
      updateCustomer(ctx, customer.id, { name: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });
});

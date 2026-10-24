import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { registerCompany } from "@/services/accounts";
import { updateCompanySettings, hasFinancialActivity } from "@/services/company";
import { makeCtx, makeAccount, resetDb } from "../../tests/factories";

describe("updateCompanySettings", () => {
  beforeEach(resetDb);

  it("round-trips every field", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    const updated = await updateCompanySettings(makeCtx(companyId), {
      name: "New Name",
      legalName: "New Name LLC",
      taxNumber: "1234567890",
      phone: "+966500000000",
      email: "info@newname.example",
      address: "123 Main St",
      currencyCode: "AED",
      defaultTaxRatePct: 500,
      timezone: "Asia/Dubai",
      allowNegativeInventory: true,
      defaultLanguage: "en",
    });

    expect(updated).toMatchObject({
      name: "New Name",
      legalName: "New Name LLC",
      taxNumber: "1234567890",
      phone: "+966500000000",
      email: "info@newname.example",
      address: "123 Main St",
      currencyCode: "AED",
      defaultTaxRatePct: 500,
      timezone: "Asia/Dubai",
      allowNegativeInventory: true,
      defaultLanguage: "en",
    });
  });

  it("fires the tax-rate guard outside 0-10000 basis points", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await expect(
      updateCompanySettings(makeCtx(companyId), { defaultTaxRatePct: 10_001 }),
    ).rejects.toMatchObject({ code: "INVALID_TAX_RATE" });
    await expect(
      updateCompanySettings(makeCtx(companyId), { defaultTaxRatePct: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_TAX_RATE" });
  });

  it("never touches onboardingCompleted", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });
    const before = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(before.onboardingCompleted).toBe(false);

    await updateCompanySettings(makeCtx(companyId), { name: "Renamed Co" });

    const after = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(after.onboardingCompleted).toBe(false);
  });

  it("writes an audit row with old and new values", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await updateCompanySettings(makeCtx(companyId), { name: "Renamed Co" });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { companyId, action: "COMPANY_SETTINGS_UPDATED" },
    });
    expect(audit.entityType).toBe("Company");
    expect(JSON.parse(audit.oldValues!)).toMatchObject({ name: "Co" });
    expect(JSON.parse(audit.newValues!)).toMatchObject({ name: "Renamed Co" });
  });

  it("never leaks a settings update across companies", async () => {
    const a = await registerCompany({
      fullName: "A", email: "a@example.com", password: "secret123", companyName: "A Co",
    });
    const b = await registerCompany({
      fullName: "B", email: "b@example.com", password: "secret123", companyName: "B Co",
    });

    await updateCompanySettings(makeCtx(a.companyId), { name: "A Renamed" });

    const bCompany = await prisma.company.findUniqueOrThrow({ where: { id: b.companyId } });
    expect(bCompany.name).toBe("B Co");
  });

  it("clears a nullable text field to null on an explicit empty string, leaving unspecified fields alone", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });
    await updateCompanySettings(makeCtx(companyId), {
      legalName: "Co LLC", phone: "+966500000000", taxNumber: "123", email: "co@example.com", address: "St 1",
    });

    const cleared = await updateCompanySettings(makeCtx(companyId), { legalName: "", phone: "" });

    expect(cleared.legalName).toBeNull();
    expect(cleared.phone).toBeNull();
    // taxNumber/email/address were never mentioned in this second call
    // (undefined, not ""), so they must survive untouched — the un-clearable
    // bug this guards against conflated "not sent" with "sent blank".
    expect(cleared.taxNumber).toBe("123");
    expect(cleared.email).toBe("co@example.com");
    expect(cleared.address).toBe("St 1");
  });

  describe("currency lock", () => {
    it("allows an early currency correction before any financial activity exists", async () => {
      const { companyId } = await registerCompany({
        fullName: "Owner", email: "owner@example.com",
        password: "secret123", companyName: "Co",
      });
      expect(await hasFinancialActivity(companyId)).toBe(false);

      await expect(
        updateCompanySettings(makeCtx(companyId), { currencyCode: "AED" }),
      ).resolves.toMatchObject({ currencyCode: "AED" });
    });

    it("rejects a currency change once a Payment exists for the company", async () => {
      const { companyId } = await registerCompany({
        fullName: "Owner", email: "owner@example.com",
        password: "secret123", companyName: "Co",
      });
      const account = await makeAccount(companyId);
      await prisma.payment.create({
        data: {
          companyId, paymentNumber: "PAY-TEST-1", paymentType: "ACCOUNT_TRANSFER",
          accountId: account.id, amount: 100,
        },
      });
      expect(await hasFinancialActivity(companyId)).toBe(true);

      await expect(
        updateCompanySettings(makeCtx(companyId), { currencyCode: "AED" }),
      ).rejects.toMatchObject({ code: "CURRENCY_LOCKED" });
    });

    it("does not lock on a DRAFT or CANCELLED order — neither ever moved real money", async () => {
      const { companyId } = await registerCompany({
        fullName: "Owner", email: "owner@example.com",
        password: "secret123", companyName: "Co",
      });
      // registerCompany itself already creates a default "MAIN" warehouse
      // (src/services/accounts.ts) — reuse it rather than makeWarehouse,
      // which would collide on the same (companyId, code) unique constraint.
      const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId } });
      await prisma.salesOrder.create({
        data: { companyId, salesOrderNumber: "SO-TEST-1", warehouseId: warehouse.id, status: "DRAFT" },
      });
      await prisma.purchaseOrder.create({
        data: { companyId, purchaseOrderNumber: "PO-TEST-1", supplierId: (await prisma.supplier.create({
          data: { companyId, name: "Test Supplier" },
        })).id, warehouseId: warehouse.id, status: "CANCELLED" },
      });
      expect(await hasFinancialActivity(companyId)).toBe(false);

      await expect(
        updateCompanySettings(makeCtx(companyId), { currencyCode: "AED" }),
      ).resolves.toMatchObject({ currencyCode: "AED" });
    });

    it("locks once a CONFIRMED sales order exists, even with no Payment/Expense yet", async () => {
      const { companyId } = await registerCompany({
        fullName: "Owner", email: "owner@example.com",
        password: "secret123", companyName: "Co",
      });
      const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId } });
      await prisma.salesOrder.create({
        data: { companyId, salesOrderNumber: "SO-TEST-1", warehouseId: warehouse.id, status: "CONFIRMED" },
      });
      expect(await hasFinancialActivity(companyId)).toBe(true);

      await expect(
        updateCompanySettings(makeCtx(companyId), { currencyCode: "AED" }),
      ).rejects.toMatchObject({ code: "CURRENCY_LOCKED" });
    });

    it("allows a no-op save (same currencyCode) even once activity exists", async () => {
      const { companyId } = await registerCompany({
        fullName: "Owner", email: "owner@example.com",
        password: "secret123", companyName: "Co",
      });
      const account = await makeAccount(companyId);
      await prisma.payment.create({
        data: {
          companyId, paymentNumber: "PAY-TEST-1", paymentType: "ACCOUNT_TRANSFER",
          accountId: account.id, amount: 100,
        },
      });

      await expect(
        updateCompanySettings(makeCtx(companyId), { currencyCode: "SAR", name: "Still Co" }),
      ).resolves.toMatchObject({ currencyCode: "SAR", name: "Still Co" });
    });
  });
});

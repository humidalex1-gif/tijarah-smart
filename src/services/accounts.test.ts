import { describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import type { Role } from "@/lib/constants";
import {
  registerCompany, inviteUser, setUserPassword, completeOnboarding, createAccount,
} from "@/services/accounts";
import { makeCtx, resetDb } from "../../tests/factories";

describe("registerCompany", () => {
  beforeEach(resetDb);

  it("creates the user, company, owner membership, warehouse, and cash account", async () => {
    const { userId, companyId } = await registerCompany({
      fullName: "Thomas", email: "owner@example.com",
      password: "secret123", companyName: "Tijarah Demo",
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe("owner@example.com");
    expect(user.passwordHash).not.toBe("secret123");
    expect(await bcrypt.compare("secret123", user.passwordHash)).toBe(true);

    const membership = await prisma.membership.findFirstOrThrow({ where: { userId } });
    expect(membership.role).toBe("OWNER");
    expect(membership.companyId).toBe(companyId);

    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId } });
    expect(warehouse.isDefault).toBe(true);

    const account = await prisma.financialAccount.findFirstOrThrow({ where: { companyId } });
    expect(account.accountType).toBe("CASH");

    expect(await prisma.expenseCategory.count({ where: { companyId } })).toBeGreaterThan(0);
  });

  it("lowercases the email and rejects a duplicate", async () => {
    await registerCompany({
      fullName: "A", email: "Owner@Example.com",
      password: "secret123", companyName: "Co A",
    });
    const user = await prisma.user.findFirstOrThrow();
    expect(user.email).toBe("owner@example.com");

    await expect(
      registerCompany({
        fullName: "B", email: "owner@example.com",
        password: "secret123", companyName: "Co B",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });
  });

  it("rejects a short password", async () => {
    await expect(
      registerCompany({
        fullName: "A", email: "a@example.com",
        password: "123", companyName: "Co",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_TOO_SHORT" });
  });
});

describe("inviteUser", () => {
  beforeEach(resetDb);

  it("adds a team member with the given role", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    const { userId } = await inviteUser(makeCtx(companyId), {
      fullName: "Sara", email: "sara@example.com",
      password: "secret123", role: "SALES_EMPLOYEE",
    });

    const membership = await prisma.membership.findFirstOrThrow({ where: { userId } });
    expect(membership.role).toBe("SALES_EMPLOYEE");
    expect(membership.companyId).toBe(companyId);
  });

  it("refuses an email that already belongs to someone", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await expect(
      inviteUser(makeCtx(companyId), {
        fullName: "Dup", email: "owner@example.com",
        password: "secret123", role: "VIEWER",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });
  });

  it("refuses an invalid role and does not create a membership row", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await expect(
      inviteUser(makeCtx(companyId), {
        fullName: "Eve", email: "eve@example.com",
        // Cast past the Role type to simulate a raw-JSON caller.
        password: "secret123", role: "SUPERUSER" as unknown as Role,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROLE" });

    expect(await prisma.membership.count({ where: { user: { email: "eve@example.com" } } }))
      .toBe(0);
    expect(await prisma.user.findUnique({ where: { email: "eve@example.com" } })).toBeNull();
  });
});

describe("setUserPassword", () => {
  beforeEach(resetDb);

  it("replaces the hash for a member of the same company", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });
    const { userId } = await inviteUser(makeCtx(companyId), {
      fullName: "Sara", email: "sara@example.com",
      password: "secret123", role: "VIEWER",
    });

    await setUserPassword(makeCtx(companyId), userId, "newsecret456");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await bcrypt.compare("newsecret456", user.passwordHash)).toBe(true);
  });

  it("refuses to touch a user outside the company", async () => {
    const a = await registerCompany({
      fullName: "A", email: "a@example.com", password: "secret123", companyName: "A Co",
    });
    const b = await registerCompany({
      fullName: "B", email: "b@example.com", password: "secret123", companyName: "B Co",
    });

    await expect(
      setUserPassword(makeCtx(a.companyId), b.userId, "hacked12345"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("completeOnboarding", () => {
  beforeEach(resetDb);

  it("stores company settings and opening balances", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await completeOnboarding(makeCtx(companyId), {
      // Deliberately non-default values — the schema defaults are "SAR"/1500,
      // so asserting those would pass even if the write were removed.
      currencyCode: "AED",
      defaultTaxRatePct: 500,
      warehouseName: "Riyadh Warehouse",
      openingCash: toMinor(5000),
      openingBank: toMinor(20000),
    });

    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.onboardingCompleted).toBe(true);
    expect(company.currencyCode).toBe("AED");
    expect(company.defaultTaxRatePct).toBe(500);

    const warehouse = await prisma.warehouse.findFirstOrThrow({
      where: { companyId, isDefault: true },
    });
    expect(warehouse.name).toBe("Riyadh Warehouse");

    const cash = await prisma.financialAccount.findFirstOrThrow({
      where: { companyId, accountType: "CASH" },
    });
    expect(cash.openingBalance).toBe(toMinor(5000));
    expect(cash.currentBalance).toBe(toMinor(5000));

    const bank = await prisma.financialAccount.findFirstOrThrow({
      where: { companyId, accountType: "BANK" },
    });
    expect(bank.currentBalance).toBe(toMinor(20000));
  });

  it("does not create a bank account when no opening bank balance is given", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await completeOnboarding(makeCtx(companyId), { openingCash: toMinor(100) });

    expect(await prisma.financialAccount.count({
      where: { companyId, accountType: "BANK" },
    })).toBe(0);
  });

  // The only thing that ever stopped a replay of the onboarding action was a
  // redirect on the PAGE — a server action is an independently addressable
  // POST endpoint, so completeOnboarding itself must refuse a second call.
  it("refuses a second call once onboarding is already completed", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await completeOnboarding(makeCtx(companyId), {
      companyName: "First Co", openingCash: toMinor(100),
    });

    await expect(
      completeOnboarding(makeCtx(companyId), { companyName: "Replayed Co" }),
    ).rejects.toMatchObject({ code: "ONBOARDING_ALREADY_COMPLETED" });

    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.name).toBe("First Co");
  });

  // The openingBank branch used to be a bare `create` with no find-or-create
  // (unlike the cash branch, which always updated the one CASH account
  // registerCompany created) — every re-run minted another funded "Bank"
  // account. Directly exercises the service (bypassing the idempotency guard
  // above) to prove the find-or-create itself, independent of replay
  // protection.
  it("updates the existing bank account instead of duplicating it on a re-run", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await completeOnboarding(makeCtx(companyId), { openingBank: toMinor(1000) });
    // Reset the flag directly so this call exercises the bank branch again
    // without tripping the ONBOARDING_ALREADY_COMPLETED guard above.
    await prisma.company.update({ where: { id: companyId }, data: { onboardingCompleted: false } });
    await completeOnboarding(makeCtx(companyId), { openingBank: toMinor(2500) });

    expect(await prisma.financialAccount.count({
      where: { companyId, accountType: "BANK" },
    })).toBe(1);

    const bank = await prisma.financialAccount.findFirstOrThrow({
      where: { companyId, accountType: "BANK" },
    });
    expect(bank.openingBalance).toBe(toMinor(2500));
    expect(bank.currentBalance).toBe(toMinor(2500));
  });
});

describe("createAccount", () => {
  beforeEach(resetDb);

  it("creates the account under the caller's company with the opening balance as currentBalance", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    const account = await createAccount(makeCtx(companyId), {
      name: "Petty Cash", accountType: "CASH", openingBalance: toMinor(500),
    });

    expect(account.companyId).toBe(companyId);
    expect(account.openingBalance).toBe(toMinor(500));
    expect(account.currentBalance).toBe(toMinor(500));

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { companyId, action: "ACCOUNT_CREATED", entityId: account.id },
    });
    expect(audit.entityType).toBe("FinancialAccount");
  });

  it("defaults the opening balance to zero when omitted", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    const account = await createAccount(makeCtx(companyId), {
      name: "Savings", accountType: "BANK",
    });

    expect(account.openingBalance).toBe(0);
    expect(account.currentBalance).toBe(0);
  });

  it("rejects a same-company name clash", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    // registerCompany already created a "Cash" account (see the test above
    // this file's registerCompany describe block).
    await expect(
      createAccount(makeCtx(companyId), { name: "Cash", accountType: "CASH" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACCOUNT_NAME" });
  });

  it("trims the name before the duplicate check and before the write", async () => {
    const { companyId } = await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    // registerCompany's own "Cash" account, clashed against via whitespace
    // that would otherwise make this look like a distinct name.
    await expect(
      createAccount(makeCtx(companyId), { name: "  Cash  ", accountType: "CASH" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACCOUNT_NAME" });

    const account = await createAccount(makeCtx(companyId), {
      name: "  Petty Cash  ", accountType: "CASH",
    });
    expect(account.name).toBe("Petty Cash");
  });

  it("allows the same name across two different companies", async () => {
    const a = await registerCompany({
      fullName: "A", email: "a@example.com", password: "secret123", companyName: "A Co",
    });
    const b = await registerCompany({
      fullName: "B", email: "b@example.com", password: "secret123", companyName: "B Co",
    });

    await createAccount(makeCtx(a.companyId), { name: "Petty Cash", accountType: "CASH" });
    await expect(
      createAccount(makeCtx(b.companyId), { name: "Petty Cash", accountType: "CASH" }),
    ).resolves.toMatchObject({ companyId: b.companyId });
  });
});

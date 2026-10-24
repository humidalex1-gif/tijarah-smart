import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { ROLES, type Role, type AccountType } from "@/lib/constants";
import { writeAudit } from "@/services/audit";
import { ServiceError, invalidState, notFound } from "@/services/errors";
import { adjustAccount } from "@/services/accounts-balance";

const MIN_PASSWORD_LENGTH = 8;

const STARTER_EXPENSE_CATEGORIES = [
  { nameAr: "إيجار", nameEn: "Rent" },
  { nameAr: "رواتب", nameEn: "Salaries" },
  { nameAr: "شحن", nameEn: "Shipping" },
  { nameAr: "إعلانات", nameEn: "Advertising" },
  { nameAr: "مرافق", nameEn: "Utilities" },
  { nameAr: "رسوم بنكية", nameEn: "Bank fees" },
  { nameAr: "مصاريف أخرى", nameEn: "Other" },
];

async function hashPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new ServiceError("PASSWORD_TOO_SHORT");
  return bcrypt.hash(password, 10);
}

async function assertEmailFree(email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ServiceError("EMAIL_ALREADY_REGISTERED", { email });
}

export async function registerCompany(input: {
  fullName: string;
  email: string;
  password: string;
  companyName: string;
  preferredLanguage?: string;
}) {
  const email = input.email.toLowerCase().trim();
  await assertEmailFree(email);
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        fullName: input.fullName,
        preferredLanguage: input.preferredLanguage ?? "ar",
      },
    });

    const company = await tx.company.create({
      data: {
        name: input.companyName,
        defaultLanguage: input.preferredLanguage ?? "ar",
      },
    });

    await tx.membership.create({
      data: { userId: user.id, companyId: company.id, role: "OWNER" },
    });

    await tx.warehouse.create({
      data: {
        companyId: company.id,
        name: "Main Warehouse",
        code: "MAIN",
        isDefault: true,
      },
    });

    await tx.financialAccount.create({
      data: {
        companyId: company.id,
        name: "Cash",
        accountType: "CASH",
        isDefault: true,
      },
    });

    for (const category of STARTER_EXPENSE_CATEGORIES) {
      await tx.expenseCategory.create({ data: { companyId: company.id, ...category } });
    }

    await writeAudit(tx, { companyId: company.id, userId: user.id }, {
      action: "COMPANY_REGISTERED",
      entityType: "Company",
      entityId: company.id,
      newValues: { name: input.companyName, ownerEmail: email },
    });

    return { userId: user.id, companyId: company.id };
  });
}

export async function inviteUser(
  ctx: ServiceContext,
  input: { fullName: string; email: string; password: string; role: Role },
) {
  // `role` is a plain string column and this input is only Role-typed at
  // compile time — a raw-JSON caller (e.g. an API route without its own
  // validation) could pass an arbitrary string. `can()` would silently map
  // an unrecognized role to zero permissions rather than fail loudly, so
  // guard it here instead.
  if (!(ROLES as readonly string[]).includes(input.role)) {
    throw invalidState("INVALID_ROLE", { role: input.role });
  }

  const email = input.email.toLowerCase().trim();
  await assertEmailFree(email);
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, passwordHash, fullName: input.fullName },
    });

    await tx.membership.create({
      data: { userId: user.id, companyId: ctx.companyId, role: input.role },
    });

    await writeAudit(tx, ctx, {
      action: "USER_INVITED",
      entityType: "User",
      entityId: user.id,
      newValues: { email, role: input.role },
    });

    return { userId: user.id };
  });
}

export async function setUserPassword(
  ctx: ServiceContext,
  userId: string,
  newPassword: string,
) {
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { userId, companyId: ctx.companyId },
    });
    if (!membership) throw notFound("User", userId);

    await tx.user.update({ where: { id: userId }, data: { passwordHash } });

    await writeAudit(tx, ctx, {
      action: "USER_PASSWORD_RESET",
      entityType: "User",
      entityId: userId,
    });
  });
}

/**
 * The finance page's add-account form — the only writer of a new
 * FinancialAccount outside `registerCompany` (Cash) and `completeOnboarding`
 * (Bank). Permission is enforced by the caller's `action()` wrapper
 * (`finance.manage_accounts`), same as every other service in this file.
 */
export async function createAccount(
  ctx: ServiceContext,
  input: { name: string; accountType: AccountType; openingBalance?: number },
) {
  // Trimmed before the duplicate check AND the write, so " Cash" and "Cash "
  // collide with an existing "Cash" instead of silently creating a
  // near-duplicate that only differs by incidental whitespace.
  const name = input.name.trim();

  return prisma.$transaction(async (tx) => {
    // Same-company name clash only — a name is scoped per tenant, not global.
    const existing = await tx.financialAccount.findFirst({
      where: { companyId: ctx.companyId, name },
    });
    if (existing) throw new ServiceError("DUPLICATE_ACCOUNT_NAME");

    const openingBalance = input.openingBalance ?? 0;
    const account = await tx.financialAccount.create({
      data: {
        companyId: ctx.companyId,
        name,
        accountType: input.accountType,
        openingBalance,
        currentBalance: openingBalance,
      },
    });

    await writeAudit(tx, ctx, {
      action: "ACCOUNT_CREATED",
      entityType: "FinancialAccount",
      entityId: account.id,
      newValues: { name, accountType: input.accountType, openingBalance },
    });

    return account;
  });
}

export async function completeOnboarding(
  ctx: ServiceContext,
  input: {
    companyName?: string;
    currencyCode?: string;
    defaultTaxRatePct?: number;
    timezone?: string;
    warehouseName?: string;
    openingCash?: number;
    openingBank?: number;
  },
) {
  await prisma.$transaction(async (tx) => {
    // First-time setup only: the only thing that ever gated a replay was a
    // redirect on the onboarding PAGE, and this is an independently
    // addressable server action — a page redirect gates nothing. Without
    // this, replaying the action after setup already completed lets it
    // rename the company, reinterpret currencyCode, overwrite the cash
    // account's currentBalance to an arbitrary absolute value, and (before
    // the find-or-create below) mint an unlimited number of funded "Bank"
    // accounts.
    const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
    if (company.onboardingCompleted) throw invalidState("ONBOARDING_ALREADY_COMPLETED");

    await tx.company.update({
      where: { id: ctx.companyId },
      data: {
        ...(input.companyName ? { name: input.companyName } : {}),
        ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
        ...(input.defaultTaxRatePct !== undefined
          ? { defaultTaxRatePct: input.defaultTaxRatePct } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        onboardingCompleted: true,
      },
    });

    if (input.warehouseName) {
      const warehouse = await tx.warehouse.findFirst({
        where: { companyId: ctx.companyId, isDefault: true },
      });
      if (warehouse) {
        await tx.warehouse.update({
          where: { id: warehouse.id },
          data: { name: input.warehouseName },
        });
      }
    }

    if (input.openingCash !== undefined) {
      const cash = await tx.financialAccount.findFirst({
        where: { companyId: ctx.companyId, accountType: "CASH" },
      });
      if (cash) {
        await tx.financialAccount.update({
          where: { id: cash.id },
          data: { openingBalance: input.openingCash },
        });
        // currentBalance mutations always route through adjustAccount (see
        // docs/decisions.md), even here where we're setting it to an absolute
        // target rather than applying a caller-supplied delta.
        await adjustAccount(tx, ctx.companyId, cash.id, input.openingCash - cash.currentBalance);
      }
    }

    if (input.openingBank !== undefined && input.openingBank > 0) {
      // Find-or-create, matching the cash branch above — without this a
      // legitimate re-run (or, pre-idempotency-guard, a replay) would mint
      // another funded "Bank" account every time instead of updating the one
      // onboarding already created.
      const bank = await tx.financialAccount.findFirst({
        where: { companyId: ctx.companyId, accountType: "BANK" },
      });
      if (bank) {
        await tx.financialAccount.update({
          where: { id: bank.id },
          data: { openingBalance: input.openingBank },
        });
        await adjustAccount(tx, ctx.companyId, bank.id, input.openingBank - bank.currentBalance);
      } else {
        await tx.financialAccount.create({
          data: {
            companyId: ctx.companyId,
            name: "Bank",
            accountType: "BANK",
            openingBalance: input.openingBank,
            currentBalance: input.openingBank,
          },
        });
      }
    }

    await writeAudit(tx, ctx, {
      action: "ONBOARDING_COMPLETED",
      entityType: "Company",
      entityId: ctx.companyId,
      newValues: input,
    });
  });
}

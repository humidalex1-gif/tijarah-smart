import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { registerCompany } from "@/services/accounts";
import { authorizeCredentials } from "@/lib/auth-credentials";
import { resetDb } from "../../tests/factories";

describe("authorizeCredentials", () => {
  beforeEach(resetDb);

  it("signs in a user with an ACTIVE membership", async () => {
    await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    const result = await authorizeCredentials({
      email: "owner@example.com", password: "secret123",
    });

    expect(result).not.toBeNull();
    expect(result?.email).toBe("owner@example.com");
    expect(result?.role).toBe("OWNER");
  });

  it("refuses sign-in when the user's membership is not ACTIVE", async () => {
    await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    await prisma.membership.updateMany({
      where: { user: { email: "owner@example.com" } },
      data: { status: "SUSPENDED" },
    });

    const result = await authorizeCredentials({
      email: "owner@example.com", password: "secret123",
    });

    expect(result).toBeNull();
  });

  it("refuses an unknown email without leaking which case it was", async () => {
    const result = await authorizeCredentials({
      email: "nobody@example.com", password: "whatever123",
    });

    expect(result).toBeNull();
  });

  it("refuses a wrong password for a known, active user", async () => {
    await registerCompany({
      fullName: "Owner", email: "owner@example.com",
      password: "secret123", companyName: "Co",
    });

    const result = await authorizeCredentials({
      email: "owner@example.com", password: "wrong-password",
    });

    expect(result).toBeNull();
  });
});

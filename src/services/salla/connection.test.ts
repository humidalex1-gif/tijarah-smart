import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { saveCredentials, getConnectionStatus, disconnect } from "@/services/salla/connection";
import { makeCompany, resetDb } from "../../../tests/factories";

describe("saveCredentials", () => {
  beforeEach(resetDb);

  it("stores the secret as ciphertext, never as plaintext", async () => {
    const company = await makeCompany();

    await saveCredentials(company.id, "client-abc", "super-secret");

    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(row?.clientSecret).not.toContain("super-secret");
    expect(row?.clientSecret.startsWith("v1.")).toBe(true);
  });

  it("leaves the stored secret untouched when given null", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");
    const before = (await prisma.sallaConnection.findUnique({
      where: { companyId: company.id },
    }))!.clientSecret;

    // The form never renders the saved secret, so an empty field must mean
    // "leave it alone" — treating it as "clear it" would wipe the secret every
    // time the owner corrected a typo in the client id.
    await saveCredentials(company.id, "client-xyz", null);

    const after = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(after!.clientSecret).toBe(before);
    expect(after!.clientId).toBe("client-xyz");
  });

  it("updates the existing row rather than creating a second one", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "secret-one");
    await saveCredentials(company.id, "client-abc", "secret-two");

    expect(await prisma.sallaConnection.count({ where: { companyId: company.id } })).toBe(1);
  });
});

describe("getConnectionStatus", () => {
  beforeEach(resetDb);

  it("reports not configured when there is no row", async () => {
    const company = await makeCompany();

    expect(await getConnectionStatus(company.id)).toMatchObject({
      configured: false,
      connected: false,
    });
  });

  it("reports configured but not connected before authorisation", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");

    expect(await getConnectionStatus(company.id)).toMatchObject({
      configured: true,
      connected: false,
    });
  });

  it("returns the client id, which is not a secret and must stay editable", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");

    // It travels in the authorize URL in plain sight; hiding it would only
    // stop the owner from seeing which app is wired up.
    expect((await getConnectionStatus(company.id)).clientId).toBe("client-abc");
  });

  it("never returns a secret or a token in its result", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");
    await prisma.sallaConnection.update({
      where: { companyId: company.id },
      data: { accessToken: encryptSecret("tok-value"), refreshToken: encryptSecret("ref-value") },
    });

    // This screen is the one place a secret could plausibly leak into a page,
    // so the guard is an assertion rather than a convention.
    const serialised = JSON.stringify(await getConnectionStatus(company.id));
    expect(serialised).not.toContain("tok-value");
    expect(serialised).not.toContain("ref-value");
    expect(serialised).not.toContain("super-secret");
  });

  it("reports the access token invalid once it has expired", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");
    await prisma.sallaConnection.update({
      where: { companyId: company.id },
      data: {
        accessToken: encryptSecret("tok"),
        refreshToken: encryptSecret("ref"),
        accessExpiresAt: new Date(Date.now() - 1000),
        connectedAt: new Date(),
      },
    });

    const status = await getConnectionStatus(company.id);
    // Still connected — an expired access token renews itself from the refresh
    // token. Only a missing refresh token means the link is actually broken.
    expect(status.connected).toBe(true);
    expect(status.accessValid).toBe(false);
  });

  it("splits the granted scopes so a missing one is visible on screen", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");
    await prisma.sallaConnection.update({
      where: { companyId: company.id },
      data: { scopes: "offline_access orders.read products.read" },
    });

    expect((await getConnectionStatus(company.id)).scopes).toEqual([
      "offline_access",
      "orders.read",
      "products.read",
    ]);
  });
});

describe("disconnect", () => {
  beforeEach(resetDb);

  it("clears the tokens but keeps the credentials", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");
    await prisma.sallaConnection.update({
      where: { companyId: company.id },
      data: {
        accessToken: encryptSecret("tok"),
        refreshToken: encryptSecret("ref"),
        connectedAt: new Date(),
      },
    });

    await disconnect(company.id);

    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(row?.accessToken).toBeNull();
    expect(row?.refreshToken).toBeNull();
    expect(row?.connectedAt).toBeNull();
    // Reconnecting must stay one click away.
    expect(row?.clientId).toBe("client-abc");
    expect(row?.clientSecret).not.toBe("");
  });
});

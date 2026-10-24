import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import {
  saveFastHubCredentials,
  getFastHubStatus,
  disconnectFastHub,
} from "@/services/fasthub/connection";
import { makeCompany, resetDb } from "../../../tests/factories";

const CREDS = {
  clientId: "client-abc",
  clientSecret: "super-secret",
  accessToken: "access-value",
  refreshToken: "refresh-value",
  webhookSecret: "hook-value",
};

describe("saveFastHubCredentials", () => {
  beforeEach(resetDb);

  it("stores every secret as ciphertext, never as plaintext", async () => {
    const company = await makeCompany();

    await saveFastHubCredentials(company.id, CREDS);

    const row = await prisma.fastHubConnection.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    // Unlike Salla, the tokens are pasted by hand rather than earned through a
    // redirect, so all four arrive together and all four must be encrypted.
    for (const [field, value] of [
      [row.clientSecret, "super-secret"],
      [row.accessToken, "access-value"],
      [row.refreshToken, "refresh-value"],
      [row.webhookSecret, "hook-value"],
    ] as const) {
      expect(field).not.toContain(value);
      expect(field!.startsWith("v1.")).toBe(true);
    }
  });

  it("records when the tokens expire so the screen can warn before they die", async () => {
    const company = await makeCompany();

    await saveFastHubCredentials(company.id, CREDS);

    const row = await prisma.fastHubConnection.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    // Fast Hub issues 30-day access and 180-day refresh tokens and does not
    // rotate them on a redirect, so the only warning the owner gets is ours.
    expect(row.accessExpiresAt).not.toBeNull();
    expect(row.refreshExpiresAt).not.toBeNull();
    expect(row.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.refreshExpiresAt!.getTime()).toBeGreaterThan(row.accessExpiresAt!.getTime());
  });

  it("leaves stored secrets untouched when given null", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, CREDS);
    const before = await prisma.fastHubConnection.findUniqueOrThrow({
      where: { companyId: company.id },
    });

    await saveFastHubCredentials(company.id, {
      clientId: "client-xyz",
      clientSecret: null,
      accessToken: null,
      refreshToken: null,
      webhookSecret: null,
    });

    const after = await prisma.fastHubConnection.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(after.clientSecret).toBe(before.clientSecret);
    expect(after.accessToken).toBe(before.accessToken);
    expect(after.clientId).toBe("client-xyz");
  });

  it("updates the existing row rather than creating a second one", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, CREDS);
    await saveFastHubCredentials(company.id, CREDS);

    expect(await prisma.fastHubConnection.count({ where: { companyId: company.id } })).toBe(1);
  });
});

describe("getFastHubStatus", () => {
  beforeEach(resetDb);

  it("reports not configured when there is no row", async () => {
    const company = await makeCompany();

    expect(await getFastHubStatus(company.id)).toMatchObject({
      configured: false,
      connected: false,
    });
  });

  it("reports connected once an access token is stored", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, CREDS);

    expect(await getFastHubStatus(company.id)).toMatchObject({
      configured: true,
      connected: true,
      accessValid: true,
    });
  });

  it("never returns a secret or a token in its result", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, CREDS);

    const serialised = JSON.stringify(await getFastHubStatus(company.id));
    for (const secret of Object.values(CREDS)) {
      if (secret === CREDS.clientId) continue; // The client id is not a secret.
      expect(serialised).not.toContain(secret);
    }
  });

  it("reports the access token invalid once it has expired", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, CREDS);
    await prisma.fastHubConnection.update({
      where: { companyId: company.id },
      data: { accessExpiresAt: new Date(Date.now() - 1000) },
    });

    const status = await getFastHubStatus(company.id);
    expect(status.connected).toBe(true);
    expect(status.accessValid).toBe(false);
  });
});

describe("disconnectFastHub", () => {
  beforeEach(resetDb);

  it("clears the tokens and cursors but keeps the credentials", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, CREDS);
    await prisma.fastHubConnection.update({
      where: { companyId: company.id },
      data: { ordersCursor: "cursor-1", returnsCursor: "cursor-2" },
    });

    await disconnectFastHub(company.id);

    const row = await prisma.fastHubConnection.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(row.accessToken).toBeNull();
    expect(row.refreshToken).toBeNull();
    // Cursors must go too: resuming an old position against a re-authorised
    // account would silently skip everything that happened in between.
    expect(row.ordersCursor).toBeNull();
    expect(row.returnsCursor).toBeNull();
    expect(row.clientId).toBe("client-abc");
  });
});

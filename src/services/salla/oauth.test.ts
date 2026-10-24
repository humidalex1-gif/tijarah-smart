import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { saveCredentials } from "@/services/salla/connection";
import { buildAuthorizeUrl, getAccessToken } from "@/services/salla/oauth";
import { sallaRedirectUri } from "@/lib/appUrl";
import { makeCompany, resetDb } from "../../../tests/factories";

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A connection whose access token has already expired, so the next read refreshes. */
async function expiredConnection() {
  const company = await makeCompany();
  await saveCredentials(company.id, "client-abc", "super-secret");
  await prisma.sallaConnection.update({
    where: { companyId: company.id },
    data: {
      accessToken: encryptSecret("expired"),
      refreshToken: encryptSecret("ref-1"),
      accessExpiresAt: new Date(Date.now() - 1000),
      connectedAt: new Date(),
    },
  });
  return company;
}

afterEach(() => vi.restoreAllMocks());

describe("buildAuthorizeUrl", () => {
  beforeEach(resetDb);

  it("requests offline_access, without which no refresh token is ever issued", () => {
    // Omitting this scope produces a link that works for exactly 14 days and
    // then dies with no way to renew it.
    const url = new URL(buildAuthorizeUrl("client-abc", "state-123"));
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("carries the client id, the state and the exact registered redirect", () => {
    const url = new URL(buildAuthorizeUrl("client-abc", "state-123"));
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe(sallaRedirectUri());
  });
});

describe("getAccessToken", () => {
  beforeEach(resetDb);

  it("returns the stored token untouched while it is still valid", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");
    await prisma.sallaConnection.update({
      where: { companyId: company.id },
      data: {
        accessToken: encryptSecret("still-good"),
        refreshToken: encryptSecret("ref-1"),
        accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await getAccessToken(company.id)).toBe("still-good");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists the ROTATED refresh token, not just the access token", async () => {
    const company = await expiredConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "fresh", refresh_token: "ref-2", expires_in: 1209600 }),
    );

    expect(await getAccessToken(company.id)).toBe("fresh");

    // ref-1 is already spent; ref-2 is the only way back. Dropping it here
    // costs the owner a manual re-authorisation, so this is the assertion the
    // whole module exists for.
    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(decryptSecret(row!.refreshToken!)).toBe("ref-2");
    expect(decryptSecret(row!.accessToken!)).toBe("fresh");
  });

  it("refreshes ONCE when two callers race, because the token is single-use", async () => {
    const company = await expiredConnection();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "fresh", refresh_token: "ref-2", expires_in: 1209600 }),
    );

    const [a, b] = await Promise.all([
      getAccessToken(company.id),
      getAccessToken(company.id),
    ]);

    expect(a).toBe("fresh");
    expect(b).toBe("fresh");
    // Two refreshes would spend ref-1 twice, which Salla answers by killing the
    // link outright rather than by failing one request.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("records the granted scopes when Salla returns them", async () => {
    const company = await expiredConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({
        access_token: "fresh",
        refresh_token: "ref-2",
        expires_in: 1209600,
        scope: "offline_access orders.read",
      }),
    );

    await getAccessToken(company.id);

    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(row!.scopes).toBe("offline_access orders.read");
  });

  it("clears the link rather than retrying when the refresh token is rejected", async () => {
    const company = await expiredConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse({}, 401));

    await expect(getAccessToken(company.id)).rejects.toThrow();

    // Leaving a spent refresh token in place would retry it forever. Clearing
    // it turns an invisible failure into "reconnect needed" on the screen.
    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(row?.refreshToken).toBeNull();
    expect(row?.accessToken).toBeNull();
  });

  it("keeps the stored refresh token when the network fails mid-refresh", async () => {
    const company = await expiredConnection();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    await expect(getAccessToken(company.id)).rejects.toThrow();

    // The token was never presented to Salla, so it is still valid. Wiping it
    // here turns every Wi-Fi blip into a manual re-authorisation.
    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(decryptSecret(row!.refreshToken!)).toBe("ref-1");
  });

  it("keeps the stored refresh token when Salla itself is down (5xx)", async () => {
    const company = await expiredConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse({}, 503));

    await expect(getAccessToken(company.id)).rejects.toThrow();

    // A 5xx says nothing about the token. Only a 4xx rejection proves it spent.
    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(decryptSecret(row!.refreshToken!)).toBe("ref-1");
  });

  it("rejects a token response with no refresh_token instead of storing half of it", async () => {
    const company = await expiredConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "fresh", expires_in: 1209600 }),
    );

    await expect(getAccessToken(company.id)).rejects.toThrow();

    // Storing the access token alone would spend ref-1 and leave nothing to
    // renew with — a link that looks healthy for 14 days and then cannot recover.
    const row = await prisma.sallaConnection.findUnique({ where: { companyId: company.id } });
    expect(decryptSecret(row!.accessToken!)).toBe("expired");
    expect(decryptSecret(row!.refreshToken!)).toBe("ref-1");
  });

  it("refuses when the company has never been connected", async () => {
    const company = await makeCompany();
    await saveCredentials(company.id, "client-abc", "super-secret");

    await expect(getAccessToken(company.id)).rejects.toThrow();
  });

  it("refuses when no credentials have been entered", async () => {
    const company = await makeCompany();

    await expect(getAccessToken(company.id)).rejects.toThrow();
  });
});

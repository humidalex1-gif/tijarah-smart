import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";

/**
 * The merchant's link to Fast Hub (Omniful).
 *
 * Unlike Salla, there is no redirect dance: Fast Hub issues the tokens in its
 * own dashboard and the owner pastes them in. So all four credentials arrive
 * together, all four are encrypted on the way in, and none of them ever comes
 * back out of this module.
 */

/** Omniful's documented lifetimes, used to warn before a link dies quietly. */
const ACCESS_TOKEN_DAYS = 30;
const REFRESH_TOKEN_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export type FastHubStatus = {
  /** Not a secret — it identifies the integration, and the owner needs to see it. */
  clientId: string | null;
  configured: boolean;
  connected: boolean;
  sellerName: string | null;
  accessValid: boolean;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  lastPolledAt: Date | null;
  connectedAt: Date | null;
};

export type FastHubCredentials = {
  clientId: string;
  /** Null on any of these means "keep the stored one". */
  clientSecret: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  webhookSecret: string | null;
};

/**
 * A null on any secret means "leave the stored one alone" — the form renders
 * every secret field empty on each visit, so treating empty as "clear it"
 * would wipe working credentials whenever the owner corrected a typo.
 */
export async function saveFastHubCredentials(
  companyId: string,
  input: FastHubCredentials,
): Promise<void> {
  const now = Date.now();
  const encrypted = {
    ...(input.clientSecret === null ? {} : { clientSecret: encryptSecret(input.clientSecret) }),
    ...(input.webhookSecret === null ? {} : { webhookSecret: encryptSecret(input.webhookSecret) }),
    // A freshly pasted token starts its clock now. Fast Hub does not tell us
    // when it was minted, and an expiry we merely guess is still far better
    // than a link that stops working with no explanation on screen.
    ...(input.accessToken === null
      ? {}
      : {
          accessToken: encryptSecret(input.accessToken),
          accessExpiresAt: new Date(now + ACCESS_TOKEN_DAYS * DAY_MS),
        }),
    ...(input.refreshToken === null
      ? {}
      : {
          refreshToken: encryptSecret(input.refreshToken),
          refreshExpiresAt: new Date(now + REFRESH_TOKEN_DAYS * DAY_MS),
        }),
  };

  await prisma.fastHubConnection.upsert({
    where: { companyId },
    update: { clientId: input.clientId, ...encrypted },
    create: {
      companyId,
      clientId: input.clientId,
      clientSecret: encrypted.clientSecret ?? "",
      ...encrypted,
      ...(input.accessToken === null ? {} : { connectedAt: new Date() }),
    },
  });

  // A row that already existed and is only now getting its first token still
  // counts as newly connected.
  if (input.accessToken !== null) {
    await prisma.fastHubConnection.updateMany({
      where: { companyId, connectedAt: null },
      data: { connectedAt: new Date() },
    });
  }
}

export async function getFastHubStatus(companyId: string): Promise<FastHubStatus> {
  const row = await prisma.fastHubConnection.findUnique({ where: { companyId } });
  if (!row) {
    return {
      clientId: null,
      configured: false,
      connected: false,
      sellerName: null,
      accessValid: false,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      lastPolledAt: null,
      connectedAt: null,
    };
  }

  return {
    clientId: row.clientId,
    configured: row.clientId !== "" && row.clientSecret !== "",
    // The access token, not the refresh token: Fast Hub's tokens are pasted
    // rather than negotiated, so holding an access token IS the connection.
    connected: row.accessToken !== null,
    sellerName: row.sellerName,
    accessValid: row.accessExpiresAt !== null && row.accessExpiresAt.getTime() > Date.now(),
    accessExpiresAt: row.accessExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    lastPolledAt: row.lastPolledAt,
    connectedAt: row.connectedAt,
  };
}

/**
 * Drops the tokens and the poll position, keeping the client id and secret so
 * reconnecting is a paste rather than a trip back to the Fast Hub dashboard.
 */
export async function disconnectFastHub(companyId: string): Promise<void> {
  await prisma.fastHubConnection.updateMany({
    where: { companyId },
    data: {
      accessToken: null,
      refreshToken: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      connectedAt: null,
      sellerId: null,
      sellerName: null,
      // Cursors go too. Resuming an old position against a re-authorised
      // account would silently skip everything that happened in between.
      ordersCursor: null,
      returnsCursor: null,
      inventoryCursor: null,
      lastPolledAt: null,
    },
  });
}

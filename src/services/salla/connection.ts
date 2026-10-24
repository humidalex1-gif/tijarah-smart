import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";

/**
 * Reading and writing the merchant's Salla link.
 *
 * Everything secret is encrypted on the way in and never comes back out of
 * this module. The OAuth dance itself lives in ./oauth.ts; this file only owns
 * the row.
 */

/**
 * Deliberately carries no secret and no token, not even a redacted one. The
 * settings screen renders this object, so anything present here is one
 * `JSON.stringify` away from the browser.
 */
export type ConnectionStatus = {
  /**
   * Safe to render: it travels in the authorize URL in plain sight, and the
   * owner needs to see which app is wired up. The SECRET never appears here.
   */
  clientId: string | null;
  /** Credentials are on file, so authorisation can be attempted. */
  configured: boolean;
  /** A refresh token exists, so the link can renew itself indefinitely. */
  connected: boolean;
  storeName: string | null;
  scopes: string[];
  connectedAt: Date | null;
  /** False merely means the next call refreshes first — not that the link broke. */
  accessValid: boolean;
};

/**
 * A null `clientSecret` means "keep the stored one".
 *
 * The form never renders the saved secret, so an empty field cannot be read as
 * "clear it" — that would wipe the secret every time the owner corrected a
 * typo in the client id.
 */
export async function saveCredentials(
  companyId: string,
  clientId: string,
  clientSecret: string | null,
): Promise<void> {
  const encrypted = clientSecret === null ? null : encryptSecret(clientSecret);
  await prisma.sallaConnection.upsert({
    where: { companyId },
    update: { clientId, ...(encrypted === null ? {} : { clientSecret: encrypted }) },
    create: { companyId, clientId, clientSecret: encrypted ?? "" },
  });
}

export async function getConnectionStatus(companyId: string): Promise<ConnectionStatus> {
  const row = await prisma.sallaConnection.findUnique({ where: { companyId } });
  if (!row) {
    return {
      clientId: null,
      configured: false,
      connected: false,
      storeName: null,
      scopes: [],
      connectedAt: null,
      accessValid: false,
    };
  }

  return {
    clientId: row.clientId,
    configured: row.clientId !== "" && row.clientSecret !== "",
    // The refresh token, not the access token: an expired access token renews
    // itself, but without a refresh token the owner must authorise by hand.
    connected: row.refreshToken !== null,
    storeName: row.storeName,
    // Shown verbatim on screen, because a missing scope explains an empty sync
    // far faster than any stack trace does.
    scopes: row.scopes ? row.scopes.split(" ").filter(Boolean) : [],
    connectedAt: row.connectedAt,
    accessValid: row.accessExpiresAt !== null && row.accessExpiresAt.getTime() > Date.now(),
  };
}

/**
 * Drops the authorisation but keeps the credentials, so reconnecting is one
 * click rather than another trip to the Salla partner portal.
 */
export async function disconnect(companyId: string): Promise<void> {
  await prisma.sallaConnection.updateMany({
    where: { companyId },
    data: {
      accessToken: null,
      refreshToken: null,
      accessExpiresAt: null,
      connectedAt: null,
      storeId: null,
      storeName: null,
      scopes: null,
    },
  });
}

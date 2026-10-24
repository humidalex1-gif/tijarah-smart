import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { sallaRedirectUri } from "@/lib/appUrl";
import { ServiceError } from "@/services/errors";

/**
 * The Salla OAuth 2.0 dance and the token lifecycle.
 *
 * Endpoints verified against Salla's documentation on 2026-08-01, not recalled.
 */

export const SALLA_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
export const SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";

/**
 * Salla compares the redirect against the portal value character for
 * character, and the identical string must appear in BOTH the authorize
 * redirect and the token exchange — hence `sallaRedirectUri()` from
 * `@/lib/appUrl`, which reads APP_URL so a deployed installation sends its
 * real address rather than the loopback it was written against.
 */

/** Refresh this far ahead of expiry, so a request in flight cannot outlive its token. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Salla's documented access-token lifetime; used only if a response omits `expires_in`. */
const DEFAULT_EXPIRES_IN_SECONDS = 14 * 24 * 60 * 60;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export function buildAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL(SALLA_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", sallaRedirectUri());
  // Without offline_access Salla issues no refresh token at all: the link then
  // works for exactly 14 days and dies with no way to renew it.
  url.searchParams.set("scope", "offline_access");
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(SALLA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  // The body is deliberately not read into the error: it can echo the client
  // secret back, and this error reaches a redirect URL. The status is enough
  // for the caller to tell a rejected token (4xx) from a Salla outage (5xx).
  if (!res.ok) throw new ServiceError("SALLA_TOKEN_REJECTED", { status: res.status });
  return (await res.json()) as TokenResponse;
}

async function credentials(companyId: string) {
  const row = await prisma.sallaConnection.findUnique({ where: { companyId } });
  if (!row || !row.clientId || !row.clientSecret) {
    throw new ServiceError("SALLA_NOT_CONFIGURED");
  }
  return { row, clientSecret: decryptSecret(row.clientSecret) };
}

/**
 * A response without a refresh token is a hard error, never a partial write:
 * storing the access token alone would spend the old refresh token and leave
 * nothing to renew with — a link that looks healthy for 14 days and then
 * cannot recover. It almost always means `offline_access` was not granted.
 */
async function persist(companyId: string, token: TokenResponse, firstConnection: boolean) {
  if (!token.access_token || !token.refresh_token) {
    throw new ServiceError("SALLA_TOKEN_INCOMPLETE");
  }
  await prisma.sallaConnection.update({
    where: { companyId },
    data: {
      accessToken: encryptSecret(token.access_token),
      refreshToken: encryptSecret(token.refresh_token),
      accessExpiresAt: new Date(
        Date.now() + (token.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
      ),
      ...(token.scope ? { scopes: token.scope } : {}),
      ...(firstConnection ? { connectedAt: new Date() } : {}),
    },
  });
}

/** Exchanges the authorization code for the first pair of tokens. */
export async function exchangeCode(companyId: string, code: string): Promise<void> {
  const { row, clientSecret } = await credentials(companyId);
  const token = await postToken({
    client_id: row.clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: sallaRedirectUri(),
  });
  await persist(companyId, token, true);
}

/**
 * Salla's refresh token is SINGLE-USE: every refresh issues a new one and
 * invalidates the old. Spending the same one twice does not fail a request —
 * it kills the link, and the owner has to authorise by hand again.
 *
 * This map collapses racing callers onto one in-flight refresh. It protects a
 * single Node process, which is this project's entire deployment. It would not
 * survive a second process, and nothing here should be taken to imply it does.
 */
const inFlight = new Map<string, Promise<string>>();

/**
 * The only supported way to obtain a token. Returns plaintext to the caller
 * and writes it nowhere.
 */
export async function getAccessToken(companyId: string): Promise<string> {
  const { row, clientSecret } = await credentials(companyId);
  if (!row.refreshToken) throw new ServiceError("SALLA_NOT_CONNECTED");

  // Narrowed inline rather than through a `const stillValid = ...` alias:
  // TypeScript does not carry the alias's narrowing into the branch once the
  // condition contains a method call, and `row.accessToken` stays `string | null`.
  const { accessToken, accessExpiresAt } = row;
  if (
    accessToken !== null &&
    accessExpiresAt !== null &&
    accessExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS
  ) {
    return decryptSecret(accessToken);
  }

  const existing = inFlight.get(companyId);
  if (existing) return existing;

  const refreshToken = decryptSecret(row.refreshToken);

  // Everything from here to `inFlight.set` runs without an await, so a racing
  // caller cannot observe the gap between the miss above and the set below.
  const run = (async () => {
    let token: TokenResponse;
    try {
      token = await postToken({
        client_id: row.clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (err) {
      // Only a 4xx from Salla proves the refresh token is spent or revoked —
      // retrying that cannot help, and a stale one left in the row would be
      // retried on every subsequent call. Clearing it turns a silent failure
      // into "reconnect needed" on screen. A network failure or a Salla 5xx
      // says nothing about the token: it was never judged, and wiping it would
      // turn every Wi-Fi blip into a manual re-authorisation.
      const status = err instanceof ServiceError ? err.details?.status : undefined;
      const tokenRejected = typeof status === "number" && status >= 400 && status < 500;
      if (tokenRejected) {
        await prisma.sallaConnection.update({
          where: { companyId },
          data: { accessToken: null, refreshToken: null, accessExpiresAt: null },
        });
      }
      throw err;
    }
    await persist(companyId, token, false);
    return token.access_token!;
  })().finally(() => inFlight.delete(companyId));

  inFlight.set(companyId, run);
  return run;
}

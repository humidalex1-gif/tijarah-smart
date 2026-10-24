import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { ServiceError } from "@/services/errors";

/**
 * The HTTP layer for Fast Hub (Omniful).
 *
 * Facts below are from docs.omniful.tech, read on 2026-08-04, not recalled:
 * bearer auth, JSON in and out, cursor pagination, UTC timestamps, and a limit
 * of 60 requests per minute for Seller and Sales Channel APIs.
 */

export const FASTHUB_BASE_URL = "https://prodapi.omniful.com";

/** Documented ceiling for Seller and Sales Channel APIs. */
const REQUESTS_PER_MINUTE = 60;
const MINUTE_MS = 60_000;
/** Bounded, so a limit that never clears fails loudly instead of looping. */
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Timestamps of recent calls, per company.
 *
 * A full catch-up walks several cursor-paginated resources and will reach the
 * ceiling on a busy day. Pacing ourselves is cheaper than being throttled, and
 * being throttled mid-walk leaves a resource half-read.
 *
 * Like the Salla refresh guard, this protects ONE Node process — which is this
 * project's entire deployment — and nothing more.
 */
const recentCalls = new Map<string, number[]>();

async function throttle(companyId: string): Promise<void> {
  const now = Date.now();
  const calls = (recentCalls.get(companyId) ?? []).filter((t) => now - t < MINUTE_MS);

  if (calls.length >= REQUESTS_PER_MINUTE) {
    const waitFor = MINUTE_MS - (now - calls[0]);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitFor)));
    return throttle(companyId);
  }

  calls.push(now);
  recentCalls.set(companyId, calls);
}

/**
 * Returns the plaintext access token, or refuses.
 *
 * Fast Hub's tokens are pasted by the owner rather than negotiated through a
 * redirect, so an expired one cannot be renewed silently. Spending a request to
 * be told 401 helps nobody — the settings screen already says what to do.
 */
async function accessToken(companyId: string): Promise<string> {
  const row = await prisma.fastHubConnection.findUnique({ where: { companyId } });
  if (!row?.accessToken) throw new ServiceError("FASTHUB_NOT_CONNECTED");
  if (row.accessExpiresAt !== null && row.accessExpiresAt.getTime() <= Date.now()) {
    throw new ServiceError("FASTHUB_TOKEN_EXPIRED");
  }
  return decryptSecret(row.accessToken);
}

function buildUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${FASTHUB_BASE_URL}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function fastHubGet<T>(
  companyId: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const token = await accessToken(companyId);
  const url = buildUrl(path, params);

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    await throttle(companyId);

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (response.status === 429) {
      // Honour Retry-After when given; otherwise back off a little further each
      // time rather than retrying at the same cadence that just failed.
      // The header is read as a STRING first: `Number(null)` is 0, so the
      // absent-header case used to pass the finite/>=0 guard and retry with
      // ZERO backoff — three instant shots at a per-minute limit, then an
      // abort a one-second wait would have avoided.
      const header = response.headers.get("Retry-After");
      const parsed = header === null ? Number.NaN : Number(header);
      const waitMs = Number.isFinite(parsed) && parsed >= 0
        ? parsed * 1000
        : (attempt + 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    // The body is deliberately never read into the error: Omniful echoes the
    // request back on some failures, and this message reaches logs and screens.
    if (!response.ok) {
      throw new ServiceError("FASTHUB_REQUEST_FAILED", { status: response.status, path });
    }

    return (await response.json()) as T;
  }

  throw new ServiceError("FASTHUB_RATE_LIMITED", { path });
}

type Paginated<T> = {
  data?: T[];
  meta?: { has_next_page?: boolean; end_cursor?: string | null };
};

/**
 * Walks a cursor-paginated resource, handing each page to `onPage`.
 *
 * Returns the cursor to resume from next time. The caller stores it only after
 * this resolves: advancing on fetch rather than after processing would skip a
 * page whose handler threw, and that page would never be seen again.
 */
export async function fastHubPaginate<T>(
  companyId: string,
  path: string,
  options: { cursor?: string | null; perPage?: number; params?: Record<string, string> },
  onPage: (page: T[]) => Promise<void>,
): Promise<string | null> {
  let cursor = options.cursor ?? null;
  let lastCursor = cursor;

  for (;;) {
    const body = await fastHubGet<Paginated<T>>(companyId, path, {
      ...(options.params ?? {}),
      per_page: String(options.perPage ?? 50),
      ...(cursor ? { search_after: cursor } : {}),
    });

    const page = body.data ?? [];
    if (page.length > 0) await onPage(page);

    const next = body.meta?.end_cursor ?? null;
    if (next) lastCursor = next;

    if (!body.meta?.has_next_page || !next || next === cursor) return lastCursor;
    cursor = next;
  }
}

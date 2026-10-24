import { ServiceError } from "@/services/errors";
import { getAccessToken } from "./oauth";

/**
 * The HTTP layer for Salla's Merchant (Admin) API.
 *
 * Auth is not negotiated here — `getAccessToken` owns the refresh, the
 * single-use rotation and the in-flight guard. This file owns one request and
 * one page walk, so a transport bug cannot be mistaken for an auth bug.
 */
export const SALLA_API_BASE = "https://api.salla.dev/admin/v2";

const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * A catalogue of two dozen products cannot need hundreds of requests. This is
 * a backstop against a paginator that reports itself wrongly, not a real limit:
 * at 50 per page it allows 2,500 products before it ever bites.
 */
const MAX_PAGES = 50;

function buildUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${SALLA_API_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function sallaGet<T>(
  companyId: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const token = await getAccessToken(companyId);
  const url = buildUrl(path, params);

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (response.status === 429) {
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

    // The body is deliberately never read into the error. Salla echoes request
    // context on some failures, this message reaches logs and screens, and a
    // token in a log is a token on disk.
    if (!response.ok) {
      throw new ServiceError("SALLA_REQUEST_FAILED", { status: response.status, path });
    }

    return (await response.json()) as T;
  }

  throw new ServiceError("SALLA_RATE_LIMITED", { path });
}

interface SallaPage<T> {
  data?: T[];
  /**
   * Confirmed against docs.salla.dev/5394168e0 on 2026-08-19, not guessed:
   * `{ count, current, next }`, where `next` is the URL of the following page
   * or null on the last one. An earlier draft of this file expected
   * `currentPage`/`totalPages`; no such fields exist.
   */
  pagination?: { count?: number; current?: number; next?: string | null };
}

/**
 * Walks a page-numbered resource, handing each page to `onPage`.
 *
 * Stops at the FIRST honest signal: a null `next`, an empty page, or a page
 * shorter than the page size. `next` is Salla's own answer and is checked
 * first; the other two are arithmetic, and they are kept because the envelope
 * is documented rather than observed here, and this project has already been
 * burned by an API whose docs disagreed with its responses on three points.
 *
 * A throwing handler is not caught: the caller decides whether a partial walk
 * is usable, and swallowing it would report a short read as a complete one.
 */
export async function sallaPaginate<T>(
  companyId: string,
  path: string,
  options: { perPage?: number; params?: Record<string, string> },
  onPage: (page: T[]) => Promise<void>,
): Promise<void> {
  const perPage = options.perPage ?? 50;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await sallaGet<SallaPage<T>>(companyId, path, {
      ...(options.params ?? {}),
      page: String(page),
      per_page: String(perPage),
    });

    const rows = body.data ?? [];
    if (rows.length === 0) return;

    await onPage(rows);

    // Salla's own answer, when it gives one.
    if (body.pagination && !body.pagination.next) return;

    // Short page: there is nothing after it, whatever the metadata says.
    if (rows.length < perPage) return;
  }
}

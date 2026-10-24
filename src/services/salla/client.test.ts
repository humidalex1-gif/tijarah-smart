import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sallaGet, sallaPaginate, SALLA_API_BASE } from "./client";
import { ServiceError } from "@/services/errors";

/**
 * The HTTP layer for Salla, kept apart from both the OAuth dance (oauth.ts)
 * and the comparison logic (costCompare.ts) so each can be wrong in isolation.
 *
 * The pagination walker is deliberately TOLERANT. Salla's page metadata is the
 * one shape here taken from documentation rather than from a live response,
 * and this project has already been burned by an API whose docs disagreed with
 * reality on three points. So the walker stops on the first honest signal it
 * gets — an empty page, a short page, or a last-page marker — instead of
 * trusting any single field to exist.
 */

const getAccessToken = vi.hoisted(() => vi.fn(async () => "tok-123"));
vi.mock("./oauth", () => ({ getAccessToken }));

const fetchMock = vi.fn();

beforeEach(() => {
  getAccessToken.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: new Headers(),
});

describe("sallaGet", () => {
  it("sends the bearer token the OAuth layer hands it, against the admin base", async () => {
    fetchMock.mockResolvedValue(ok({ data: [] }));

    await sallaGet("c1", "/products", { per_page: "50" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url).startsWith(SALLA_API_BASE)).toBe(true);
    expect(String(url)).toContain("/products");
    expect(String(url)).toContain("per_page=50");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });

  it("drops empty parameters instead of sending them as blanks", async () => {
    fetchMock.mockResolvedValue(ok({ data: [] }));

    await sallaGet("c1", "/products", { page: "", per_page: "50" });

    // Checked as a PARAMETER, not a substring: "per_page=50" contains "page=".
    const sent = new URL(String(fetchMock.mock.calls[0]![0])).searchParams;
    expect(sent.has("page")).toBe(false);
    expect(sent.get("per_page")).toBe("50");
  });

  it("raises a typed error on failure and never leaks the response body", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403, headers: new Headers(),
      json: async () => ({ error: { message: "token abcdef leaked here" } }),
    });

    // The message reaches logs and screens; Salla echoes request context on
    // some failures, and a token in a log is a token on disk.
    const err = await sallaGet("c1", "/products").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("SALLA_REQUEST_FAILED");
    expect(JSON.stringify(err)).not.toContain("abcdef");
  });

  it("retries once a rate limit clears, honouring Retry-After", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "Retry-After": "0" }), json: async () => ({}) })
      .mockResolvedValueOnce(ok({ data: [{ id: 1 }] }));

    const body = await sallaGet<{ data: { id: number }[] }>("c1", "/products");

    expect(body.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up with its own code rather than looping on a persistent rate limit", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, headers: new Headers({ "Retry-After": "0" }), json: async () => ({}) });

    const err = await sallaGet("c1", "/products").catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe("SALLA_RATE_LIMITED");
  });
});

describe("sallaPaginate", () => {
  it("walks every page and hands each to the caller", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: 1 }, { id: 2 }], pagination: { count: 3, current: 1, next: "https://api.salla.dev/admin/v2/products?page=2" } }))
      .mockResolvedValueOnce(ok({ data: [{ id: 3 }], pagination: { count: 3, current: 2, next: null } }));

    const seen: number[] = [];
    await sallaPaginate<{ id: number }>("c1", "/products", { perPage: 2 }, async (page) => {
      seen.push(...page.map((p) => p.id));
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops on an empty page even when Salla still offers a next link", async () => {
    // The honest signal beats the claimed one: a walker that trusted
    // totalPages here would loop forever against a paginator that lies.
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: 1 }], pagination: { count: 99, current: 1, next: "https://api.salla.dev/admin/v2/products?page=2" } }))
      .mockResolvedValueOnce(ok({ data: [], pagination: { count: 99, current: 2, next: "https://api.salla.dev/admin/v2/products?page=2" } }));

    const seen: number[] = [];
    await sallaPaginate<{ id: number }>("c1", "/products", { perPage: 1 }, async (page) => {
      seen.push(...page.map((p) => p.id));
    });

    expect(seen).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops on a short page without needing any metadata at all", async () => {
    // Salla's pagination field names are the one shape here taken from docs
    // rather than a live response. A short page is arithmetic, not trust.
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 1 }] }));

    const seen: number[] = [];
    await sallaPaginate<{ id: number }>("c1", "/products", { perPage: 50 }, async (page) => {
      seen.push(...page.map((p) => p.id));
    });

    expect(seen).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to walk forever when next never becomes null", async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ id: 1 }, { id: 2 }], pagination: { count: 9999, current: 1, next: "https://api.salla.dev/admin/v2/products?page=2" } }));

    const seen: number[] = [];
    await sallaPaginate<{ id: number }>("c1", "/products", { perPage: 2 }, async (page) => {
      seen.push(...page.map((p) => p.id));
    });

    // A catalogue of ~23 products cannot need hundreds of requests; a walk
    // that does is a bug, and a bounded one is diagnosable.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(50);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not swallow a handler that throws mid-walk", async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ id: 1 }, { id: 2 }], pagination: { count: 6, current: 1, next: "https://api.salla.dev/admin/v2/products?page=2" } }));

    await expect(
      sallaPaginate<{ id: number }>("c1", "/products", { perPage: 2 }, async () => {
        throw new Error("handler exploded");
      }),
    ).rejects.toThrow("handler exploded");
  });

  it("stops when Salla's own pagination says there is no next page", async () => {
    // The REAL envelope, confirmed at docs.salla.dev/5394168e0 on 2026-08-19:
    // { status, success, data, pagination: { count, current, next } }.
    // `next` is a URL or null — it is the authoritative signal, and the
    // earlier guess of currentPage/totalPages does not exist.
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: 1 }, { id: 2 }], pagination: { count: 3, current: 1, next: "https://api.salla.dev/admin/v2/products?page=2" } }))
      .mockResolvedValueOnce(ok({ data: [{ id: 3 }, { id: 4 }], pagination: { count: 3, current: 2, next: null } }));

    const seen: number[] = [];
    await sallaPaginate<{ id: number }>("c1", "/products", { perPage: 2 }, async (page) => {
      seen.push(...page.map((p) => p.id));
    });

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

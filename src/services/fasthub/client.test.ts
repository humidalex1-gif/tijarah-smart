import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { saveFastHubCredentials } from "@/services/fasthub/connection";
import { fastHubGet, fastHubPaginate, FASTHUB_BASE_URL } from "@/services/fasthub/client";
import { makeCompany, resetDb } from "../../../tests/factories";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function connected() {
  const company = await makeCompany();
  await saveFastHubCredentials(company.id, {
    clientId: "client-abc",
    clientSecret: "secret",
    accessToken: "the-access-token",
    refreshToken: "the-refresh-token",
    webhookSecret: null,
  });
  return company;
}

afterEach(() => vi.restoreAllMocks());

describe("fastHubGet", () => {
  beforeEach(resetDb);

  it("sends the decrypted token as a Bearer header against the documented base URL", async () => {
    const company = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: [] }));

    await fastHubGet(company.id, "/orders", { per_page: "50" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${FASTHUB_BASE_URL}/orders`)).toBe(true);
    expect(url).toContain("per_page=50");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer the-access-token");
  });

  it("refuses before calling out when no token is stored", async () => {
    const company = await makeCompany();
    await saveFastHubCredentials(company.id, {
      clientId: "client-abc", clientSecret: "secret",
      accessToken: null, refreshToken: null, webhookSecret: null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fastHubGet(company.id, "/orders")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses before calling out when the token has expired", async () => {
    const company = await connected();
    await prisma.fastHubConnection.update({
      where: { companyId: company.id },
      data: { accessExpiresAt: new Date(Date.now() - 1000) },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Fast Hub tokens are pasted rather than negotiated, so an expired one
    // cannot be renewed silently — spending a request to be told 401 helps
    // nobody and the screen already says what to do.
    await expect(fastHubGet(company.id, "/orders")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries once after a 429 and succeeds", async () => {
    const company = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 1 }] }));

    const body = await fastHubGet<{ data: { id: number }[] }>(company.id, "/orders");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(body.data).toHaveLength(1);
  });

  it("gives up rather than hammering a rate limit that will not clear", async () => {
    const company = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "0" } }));

    await expect(fastHubGet(company.id, "/orders")).rejects.toThrow();
    // One original plus a bounded number of retries, never an open loop.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not put the response body into the error on failure", async () => {
    const company = await connected();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "token the-access-token is invalid" }, 401),
    );

    // Error text reaches logs and screens; an echoed token must not ride along.
    await expect(fastHubGet(company.id, "/orders")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("the-access-token") }),
    );
  });
});

describe("fastHubPaginate", () => {
  beforeEach(resetDb);

  it("follows the cursor until the last page and returns every record", async () => {
    const company = await connected();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 1 }, { id: 2 }],
        meta: { has_next_page: true, end_cursor: "cursor-2" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 3 }],
        meta: { has_next_page: false, end_cursor: "cursor-3" },
      }));

    const pages: unknown[][] = [];
    const last = await fastHubPaginate<{ id: number }>(
      company.id, "/orders", {}, async (page) => { pages.push(page); },
    );

    expect(pages.flat()).toHaveLength(3);
    expect(last).toBe("cursor-3");
  });

  it("passes the caller's starting cursor through as search_after", async () => {
    const company = await connected();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ data: [], meta: { has_next_page: false, end_cursor: null } }),
    );

    await fastHubPaginate(company.id, "/orders", { cursor: "resume-here" }, async () => {});

    expect(fetchSpy.mock.calls[0][0]).toContain("search_after=resume-here");
  });

  it("stops at the page whose handler throws, keeping the cursor before it", async () => {
    const company = await connected();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 1 }], meta: { has_next_page: true, end_cursor: "cursor-2" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 2 }], meta: { has_next_page: true, end_cursor: "cursor-3" },
      }));

    let seen = 0;
    // Advancing the cursor on fetch rather than after processing would skip the
    // failed page forever on the next run.
    await expect(
      fastHubPaginate<{ id: number }>(company.id, "/orders", {}, async () => {
        seen += 1;
        if (seen === 2) throw new Error("processing failed");
      }),
    ).rejects.toThrow();
  });

  it("backs off when a 429 arrives with NO Retry-After header at all", async () => {
    // Number(null) is 0, which passed the isFinite/>=0 guard — so the absent
    // header meant zero backoff: three instant retries against a per-minute
    // limit, then the sync aborted where a one-second wait would save it.
    const company = await connected();
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await fastHubGet(company.id, "/orders");

    expect(delays.some((ms) => ms >= 1000)).toBe(true);
  })
});

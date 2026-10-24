/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach } from "vitest";

const exchangeCode = vi.fn();
vi.mock("@/services/salla/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/salla/oauth")>()),
  exchangeCode: (...args: unknown[]) => exchangeCode(...args),
}));

vi.mock("@/lib/appContext", () => ({
  loadAppContext: async () => ({ companyId: "c1", role: "OWNER" }),
  requirePermission: () => {},
}));

const cookieStore = { get: vi.fn(), delete: vi.fn(), set: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

import { GET } from "./route";

function callbackRequest(query: string) {
  return new Request(`http://127.0.0.1:3000/api/salla/callback?${query}`);
}

beforeEach(() => {
  exchangeCode.mockReset();
  cookieStore.get.mockReset();
  cookieStore.delete.mockReset();
});

describe("GET /api/salla/callback", () => {
  it("refuses a state that does not match the cookie", async () => {
    cookieStore.get.mockReturnValue({ value: "expected-state" });

    const res = await GET(callbackRequest("code=x&state=forged"));

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=1");
  });

  it("refuses when there is no state cookie at all", async () => {
    cookieStore.get.mockReturnValue(undefined);

    const res = await GET(callbackRequest("code=x&state=any"));

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=1");
  });

  it("refuses when Salla sent no code", async () => {
    cookieStore.get.mockReturnValue({ value: "good-state" });

    const res = await GET(callbackRequest("state=good-state"));

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=1");
  });

  it("exchanges the code and reports success when the state matches", async () => {
    cookieStore.get.mockReturnValue({ value: "good-state" });

    const res = await GET(callbackRequest("code=the-code&state=good-state"));

    expect(exchangeCode).toHaveBeenCalledWith("c1", "the-code");
    expect(res.headers.get("location")).toContain("connected=1");
  });

  it("burns the state cookie even when the exchange succeeds", async () => {
    cookieStore.get.mockReturnValue({ value: "good-state" });

    await GET(callbackRequest("code=the-code&state=good-state"));

    // A surviving state cookie is a replayable one.
    expect(cookieStore.delete).toHaveBeenCalled();
  });

  it("never puts the code or an error detail in the redirect", async () => {
    cookieStore.get.mockReturnValue({ value: "good-state" });
    exchangeCode.mockRejectedValue(new Error("client_secret is wrong"));

    const res = await GET(callbackRequest("code=the-code&state=good-state"));

    // This URL lands in the address bar, in history, and in any screenshot the
    // owner sends. It carries a flag, never a message.
    const location = res.headers.get("location")!;
    expect(location).not.toContain("the-code");
    expect(location).not.toContain("client_secret");
    expect(location).toContain("error=1");
  });
});

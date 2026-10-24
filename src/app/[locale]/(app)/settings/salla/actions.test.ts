import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/salla/connection", () => ({
  saveCredentials: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
}));

const actions = await import("./actions");
const { prisma } = await import("@/lib/db");
const svc = await import("@/services/salla/connection");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

function mockRole(role: string) {
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role } as never);
}

describe("saveSallaCredentialsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole("OWNER");
  });

  it("passes null for an empty secret so the stored one survives", async () => {
    // The field renders empty on every visit because the saved secret never
    // reaches the browser. Reading that as "clear it" would wipe the secret
    // every time the owner corrected a typo in the client id.
    const result = await actions.saveSallaCredentialsAction(
      form({ clientId: "client-abc", clientSecret: "" }),
    );

    expect(result.ok).toBe(true);
    expect(svc.saveCredentials).toHaveBeenCalledWith("c1", "client-abc", null);
  });

  it("treats a whitespace-only secret as absent, not as a secret", async () => {
    await actions.saveSallaCredentialsAction(
      form({ clientId: "client-abc", clientSecret: "   " }),
    );

    expect(svc.saveCredentials).toHaveBeenCalledWith("c1", "client-abc", null);
  });

  it("trims and stores a supplied secret", async () => {
    await actions.saveSallaCredentialsAction(
      form({ clientId: "  client-abc  ", clientSecret: "  a-secret  " }),
    );

    expect(svc.saveCredentials).toHaveBeenCalledWith("c1", "client-abc", "a-secret");
  });

  it("rejects an empty client id without writing anything", async () => {
    const result = await actions.saveSallaCredentialsAction(
      form({ clientId: "   ", clientSecret: "a-secret" }),
    );

    expect(result.ok).toBe(false);
    expect(svc.saveCredentials).not.toHaveBeenCalled();
  });

  it("never returns the submitted secret in its result", async () => {
    const result = await actions.saveSallaCredentialsAction(
      form({ clientId: "client-abc", clientSecret: "a-secret" }),
    );

    expect(JSON.stringify(result)).not.toContain("a-secret");
  });

  it("refuses a role that cannot edit settings", async () => {
    mockRole("SALES_EMPLOYEE");

    const result = await actions.saveSallaCredentialsAction(
      form({ clientId: "client-abc", clientSecret: "a-secret" }),
    );

    expect(result.ok).toBe(false);
    expect(svc.saveCredentials).not.toHaveBeenCalled();
  });

  it("returns an error rather than redirecting when the session is gone", async () => {
    const { requireSession } = await import("@/lib/auth");
    vi.mocked(requireSession).mockRejectedValueOnce(new Error("no session"));

    // The page helpers redirect on an expired session, which would bounce the
    // owner to login and silently discard the form. An action must report.
    const result = await actions.saveSallaCredentialsAction(
      form({ clientId: "client-abc", clientSecret: "a-secret" }),
    );

    expect(result.ok).toBe(false);
    expect(svc.saveCredentials).not.toHaveBeenCalled();
  });
});

describe("disconnectSallaAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole("OWNER");
  });

  it("disconnects the company in session", async () => {
    const result = await actions.disconnectSallaAction(new FormData());

    expect(result.ok).toBe(true);
    expect(svc.disconnect).toHaveBeenCalledWith("c1");
  });

  it("refuses a role that cannot edit settings", async () => {
    mockRole("VIEWER");

    const result = await actions.disconnectSallaAction(new FormData());

    expect(result.ok).toBe(false);
    expect(svc.disconnect).not.toHaveBeenCalled();
  });
});

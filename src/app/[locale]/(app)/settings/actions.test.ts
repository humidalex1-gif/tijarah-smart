import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));

// action()'s own permission gate re-reads Membership for the ACTING user
// (session.userId, "u1"), and the guards this file adds re-read Membership
// again — once for the acting user (inviteUserAction, same "u1" row) and
// once for the TARGET user (setUserPasswordAction, a different id) — so the
// mock has to answer differently depending on which userId it's asked
// about, not just return one static row like the simpler actions.test.ts
// files elsewhere.
let actingRole = "ADMIN";
let targetRole = "VIEWER";
vi.mock("@/lib/db", () => ({
  prisma: {
    membership: {
      // `userId` on the returned row matters here, not just `role` — the
      // setUserPasswordAction guard compares `target.userId !== ctx.userId`
      // to tell "an admin resetting the owner" (refused) apart from "the
      // owner resetting themself" (allowed), so a mock missing `userId`
      // would make every self-reset look like a stranger's.
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => {
        if (where.userId === "u1") return { role: actingRole, userId: "u1" };
        if (where.userId === "u2") return { role: targetRole, userId: "u2" };
        return null;
      }),
    },
  },
}));
vi.mock("@/services/accounts", () => ({
  inviteUser: vi.fn(async () => ({ userId: "new-user" })),
  setUserPassword: vi.fn(async () => undefined),
}));
vi.mock("@/services/company", () => ({
  updateCompanySettings: vi.fn(async () => ({ id: "c1" })),
}));

const { inviteUserAction, setUserPasswordAction } = await import("./actions");
const { inviteUser, setUserPassword } = await import("@/services/accounts");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

describe("settings team actions guard the OWNER row", () => {
  beforeEach(() => {
    actingRole = "ADMIN";
    targetRole = "VIEWER";
    vi.mocked(inviteUser).mockClear();
    vi.mocked(setUserPassword).mockClear();
  });

  it("refuses an ADMIN inviting a new OWNER", async () => {
    const result = await inviteUserAction(form({
      fullName: "New Owner", email: "new@example.com", password: "secret123", role: "OWNER",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it("allows the OWNER themself to invite another OWNER", async () => {
    actingRole = "OWNER";

    const result = await inviteUserAction(form({
      fullName: "New Owner", email: "new@example.com", password: "secret123", role: "OWNER",
    }));

    expect(result.ok).toBe(true);
    expect(inviteUser).toHaveBeenCalled();
  });

  it("still allows an ADMIN to invite a non-OWNER role", async () => {
    const result = await inviteUserAction(form({
      fullName: "New Viewer", email: "viewer@example.com", password: "secret123", role: "VIEWER",
    }));

    expect(result.ok).toBe(true);
    expect(inviteUser).toHaveBeenCalled();
  });

  it("refuses an ADMIN resetting a DIFFERENT user's password when that user is the OWNER", async () => {
    targetRole = "OWNER";

    const result = await setUserPasswordAction(form({ userId: "u2", newPassword: "newsecret123" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(setUserPassword).not.toHaveBeenCalled();
  });

  it("allows the OWNER to reset their own password", async () => {
    // /settings/team is the only password-setting surface in Stage 1 (no
    // forgot-password route, no self-service change, no profile page) — an
    // unconditional OWNER refusal would strand an owner who forgets their
    // own password with zero recovery path. Same session ("u1") acts on
    // itself: the acting-permission check and the target-role check both
    // resolve to the same OWNER row.
    actingRole = "OWNER";

    const result = await setUserPasswordAction(form({ userId: "u1", newPassword: "newsecret123" }));

    expect(result.ok).toBe(true);
    expect(setUserPassword).toHaveBeenCalled();
  });

  it("still allows an ADMIN to reset a non-OWNER member's password", async () => {
    targetRole = "SALES_EMPLOYEE";

    const result = await setUserPasswordAction(form({ userId: "u2", newPassword: "newsecret123" }));

    expect(result.ok).toBe(true);
    expect(setUserPassword).toHaveBeenCalled();
  });
});

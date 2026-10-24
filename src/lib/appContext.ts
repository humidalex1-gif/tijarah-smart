import { cache } from "react";
import { redirect } from "next/navigation";
import type { Company, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireSessionOrRedirect } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/constants";
import { can, type Permission } from "@/lib/permissions";
import type { Locale } from "@/lib/i18n";

export interface AppContext {
  userId: string;
  companyId: string;
  role: Role;
  company: Company;
  user: User;
  /** Company.currencyCode — every money value on every screen formats with this. */
  currency: string;
}

/**
 * The single funnel every authenticated page goes through: identity, a fresh
 * membership/role read, and the company row money is formatted against.
 * Wrapped in React `cache()` so the (app) layout and the page it wraps share
 * one set of queries per request instead of doubling them.
 *
 * Stale-token rule (docs/decisions.md #2): a valid JWT whose backing rows no
 * longer resolve is UNAUTHENTICATED, not a server error — `session.companyId`
 * / `session.userId` can outlive the rows they point at for up to the token's
 * 24h maxAge (a deleted company, a removed membership, stale dev/test data).
 * Every lookup here uses `findUnique`/`findFirst`, never an "OrThrow" variant,
 * and a miss redirects to login instead of throwing Prisma's P2025.
 *
 * Layout-is-not-a-gate (docs/decisions.md #10): Next renders a route's layout
 * and page in parallel, and a shared layout is NOT re-rendered on client-side
 * navigation between sibling segments under it — so `(app)/layout.tsx`
 * calling this is never sufficient authorization by itself. EVERY PAGE must
 * call `loadAppContext()` itself. The `(app)` layout's own call exists only
 * to read `company`/`role` for its presentation (the onboarding redirect, the
 * role passed to `Sidebar`) — treat it as decoration, never as a gate a page
 * can skip re-checking.
 */
export const loadAppContext = cache(async (locale: Locale): Promise<AppContext> => {
  const session = await requireSessionOrRedirect(locale);

  const [company, user, membership] = await Promise.all([
    prisma.company.findUnique({ where: { id: session.companyId } }),
    prisma.user.findUnique({ where: { id: session.userId } }),
    // The JWT's role claim is a display cache, not authority (decisions.md #2):
    // session rolling refresh can carry a demoted/deactivated role past the
    // 24h idle window. Re-read Membership and use THIS row's role/status.
    prisma.membership.findFirst({
      where: { userId: session.userId, companyId: session.companyId, status: "ACTIVE" },
    }),
  ]);

  if (!company || !user || !membership) redirect(`/${locale}/login`);

  // Validate the re-read role string against ROLES before it can reach can()
  // (decisions.md #3) — can() silently maps an unrecognized role to zero
  // permissions rather than failing loudly.
  if (!(ROLES as readonly string[]).includes(membership.role)) {
    redirect(`/${locale}/login`);
  }

  return {
    userId: session.userId,
    companyId: session.companyId,
    role: membership.role as Role,
    company,
    user,
    currency: company.currencyCode,
  };
});

/**
 * Gate a page behind a `Permission`, redirecting to the dashboard instead of
 * throwing. `permissions.ts`'s `assertCan` throws `ServiceError("FORBIDDEN")`
 * — the right behavior inside a server action, where the caller already
 * catches and translates thrown `ServiceError`s, but WRONG for a Server
 * Component page: there's no catcher for that throw anywhere in the tree
 * (short of an `error.tsx` boundary — see `(app)/error.tsx`, which exists as
 * a backstop, not the primary path), so it renders Next's default 500 page.
 * A signed-in user hitting a screen their role can't see (e.g. a
 * SALES_EMPLOYEE opening /finance by URL) is a ROUTINE case, not a server
 * failure — `notFound()` would also be wrong here for the same reason a 500
 * is: the user IS authenticated, they just can't see this one screen, and
 * bouncing them to the dashboard beats a dead end either way.
 *
 * Every (app) page must call this — not `assertCan` — for its top-level
 * permission check, immediately after `loadAppContext()`. This is the
 * pattern Tasks 5–9 copy (see `(app)/page.tsx`'s dashboard gate).
 */
export function requirePermission(ctx: AppContext, permission: Permission, locale: Locale): void {
  if (!can(ctx.role, permission)) {
    redirect(`/${locale}/dashboard`);
  }
}

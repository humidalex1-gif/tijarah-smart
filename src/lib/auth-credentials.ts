import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";

/**
 * Kept in its own module, separate from `@/lib/auth`, deliberately: that
 * file imports `next-auth`, which pulls in `next/server` and fails to
 * resolve under the plain Node vitest environment this project's tests run
 * in. This module only touches bcrypt/Prisma, so it can be exercised
 * directly in tests without booting NextAuth.
 */

/**
 * Precomputed bcrypt hash of a fixed, non-secret dummy password. It is
 * compared against on the not-found/inactive sign-in paths below purely to
 * burn the same ~bcrypt-cost of wall-clock time that a real password check
 * would take. Without this, an unknown-email request returns almost
 * instantly while a known-email request takes ~100ms for the real
 * `bcrypt.compare`, letting an attacker enumerate registered emails by
 * timing responses. The hash never gates access to anything.
 */
const DUMMY_PASSWORD_HASH = "$2b$10$SWUx/UXwHqlMwaWr7c7CCOGL4N3ZKdF8r5LHEPzF1Fzm10aHVmO9m";

/**
 * Credentials authorize handler, exported so it can be exercised directly in
 * tests without going through the full NextAuth request pipeline.
 *
 * A sign-in fails uniformly (returns null, no differentiating error) for:
 * unknown email, inactive user, no ACTIVE membership, or wrong password.
 */
export async function authorizeCredentials(
  creds: Partial<Record<"email" | "password", unknown>> | undefined,
) {
  const email = String(creds?.email ?? "").toLowerCase().trim();
  const password = String(creds?.password ?? "");

  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { where: { status: "ACTIVE" } } },
  });

  const membership = user?.memberships[0];

  if (!user || user.status !== "ACTIVE" || !membership) {
    // See DUMMY_PASSWORD_HASH above — keeps this path's timing close to the
    // real-compare path so it can't be used to enumerate emails.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    id: user.id,
    email: user.email,
    name: user.fullName,
    companyId: membership.companyId,
    role: membership.role,
  };
}

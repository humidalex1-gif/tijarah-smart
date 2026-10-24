import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { redirect } from "next/navigation";
import type { Role } from "@/lib/constants";
import { authorizeCredentials } from "@/lib/auth-credentials";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Required the moment this runs anywhere but a dev server. NextAuth refuses
  // to infer its own base URL from an untrusted Host header in production and
  // fails every request with UntrustedHost — which surfaces as "login is
  // broken on the server" and nowhere else. Found by running the production
  // build locally, not on the VPS.
  //
  // Trusting the header is bounded here: the app sits behind a reverse proxy
  // configured for exactly one hostname, and the one place a forged host could
  // do real damage — the Salla OAuth redirect — does not read it. That comes
  // from APP_URL (src/lib/appUrl.ts), which is configuration, not a header.
  trustHost: true,
  // maxAge caps the IDLE lifetime of a token at 24h (vs NextAuth's 30-day
  // default). Note the limit of this mechanism: companyId/role are written
  // into the token only at sign-in, and NextAuth's rolling refresh extends
  // an actively-used session without re-deriving claims — so a continuously
  // active user can carry a stale (e.g. demoted) role PAST 24h, until they
  // log out. Per-request DB re-reads are deliberately NOT done here in
  // Stage 1A: the JWT is a convenience cache for session display, never the
  // authority. Stage 1B's route layer must re-read membership from the DB
  // before sensitive actions (recorded decision).
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 },
  pages: { signIn: `/${DEFAULT_LOCALE}/login` },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: authorizeCredentials,
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const u = user as { id: string; companyId: string; role: string };
        token.id = u.id;
        token.companyId = u.companyId;
        token.role = u.role;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.companyId = token.companyId as string;
      session.user.role = token.role as string;
      return session;
    },
  },
});

/** Server-side guard for every page and action: returns the caller's scope. */
export async function requireSession(): Promise<{
  userId: string; companyId: string; role: Role;
}> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("UNAUTHENTICATED");
  return {
    userId: session.user.id,
    companyId: session.user.companyId as string,
    role: session.user.role as Role,
  };
}

/** Page-level guard: send signed-out visitors to their locale's login page. */
export async function requireSessionOrRedirect(locale: Locale) {
  try {
    return await requireSession();
  } catch {
    redirect(`/${locale}/login`);
  }
}

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { buildAuthorizeUrl } from "@/services/salla/oauth";
import { appOrigin } from "@/lib/appUrl";
import { DEFAULT_LOCALE } from "@/lib/i18n";

/**
 * Step one of the OAuth dance: send the owner to Salla to approve the app.
 *
 * A route handler rather than a server action because this is a browser
 * redirect to a third-party origin, which an action cannot perform.
 */

export const STATE_COOKIE = "salla_oauth_state";

/**
 * Where this installation is reached. Was a loopback constant while the app
 * only ran on the owner's laptop; a deployed copy must redirect to its own
 * address, or the owner lands on a machine that is not the one they are using.
 */

export async function GET() {
  const ctx = await loadAppContext(DEFAULT_LOCALE);
  // Redirects rather than returning, so an unauthenticated hit lands on login
  // and never on Salla.
  requirePermission(ctx, "settings.edit", DEFAULT_LOCALE);

  const row = await prisma.sallaConnection.findUnique({ where: { companyId: ctx.companyId } });
  if (!row?.clientId) {
    // Nothing to authorise with. Fail back to the screen that can fix it.
    return NextResponse.redirect(
      new URL(`/${DEFAULT_LOCALE}/settings/salla?error=1`, appOrigin()),
    );
  }

  const state = randomBytes(32).toString("hex");
  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax", // Must survive the top-level redirect back from Salla.
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizeUrl(row.clientId, state));
}

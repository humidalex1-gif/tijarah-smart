import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { exchangeCode } from "@/services/salla/oauth";
import { DEFAULT_LOCALE } from "@/lib/i18n";
import { STATE_COOKIE } from "../authorize/route";
import { appOrigin } from "@/lib/appUrl";

/**
 * Step two: Salla sends the owner back here with a code. Verify the state,
 * trade the code for tokens, and return to the settings screen.
 */

/**
 * A flag, never a message.
 *
 * This URL lands in the address bar, in browser history, and in any screenshot
 * the owner sends for help. An error detail here could carry the authorization
 * code or an echoed client secret with it.
 */
function back(flag: "connected=1" | "error=1") {
  return NextResponse.redirect(
    new URL(`/${DEFAULT_LOCALE}/settings/salla?${flag}`, appOrigin()),
  );
}

function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const ctx = await loadAppContext(DEFAULT_LOCALE);
  requirePermission(ctx, "settings.edit", DEFAULT_LOCALE);

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");

  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  // Burn it unconditionally: a surviving state cookie is a replayable one.
  jar.delete(STATE_COOKIE);

  if (!code || !state || !expected || !sameState(state, expected)) {
    // A mismatch is a forged or stale callback. Never a retry.
    return back("error=1");
  }

  try {
    await exchangeCode(ctx.companyId, code);
  } catch {
    return back("error=1");
  }

  return back("connected=1");
}

/**
 * Where this installation actually lives.
 *
 * Everything was hardcoded to `http://127.0.0.1:3000` while the app only ever
 * ran on the owner's laptop. Moving it to a server makes that a real defect in
 * exactly one place that matters most: Salla compares the OAuth redirect
 * against the portal value CHARACTER FOR CHARACTER, so a stale loopback URL
 * does not degrade the connection — it refuses it outright.
 *
 * Read at call time rather than frozen into a module-level constant: Next
 * imports modules during the build, where the server's environment does not
 * exist yet, and a constant would capture the build machine's value forever.
 */

const LOCAL_ORIGIN = "http://127.0.0.1:3000";

export function appOrigin(): string {
  const configured = process.env.APP_URL?.trim();
  if (!configured) return LOCAL_ORIGIN;
  // A trailing slash would double up against every path appended to it, and
  // the resulting URL is one Salla rejects as a mismatch.
  return configured.replace(/\/+$/, "");
}

/**
 * The one place this URL is spelled out. It must be identical in the authorize
 * redirect, in the token exchange, and in the Salla portal — three copies of a
 * string is three chances for them to drift.
 */
export function sallaRedirectUri(): string {
  return `${appOrigin()}/api/salla/callback`;
}

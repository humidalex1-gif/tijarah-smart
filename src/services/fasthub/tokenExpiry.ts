/**
 * How long the Fast Hub access token has left, in the owner's terms.
 *
 * The token is pasted by hand and never renewed by the app — client.ts
 * refuses an expired one on purpose, because a token it cannot renew is not
 * one it should keep spending requests on. That made the sync turning red
 * the first and only warning. This gives the dashboard a week's notice.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A week: long enough to act on, short enough not to become wallpaper. */
const WARN_WITHIN_DAYS = 7;

export type AccessExpiry =
  | { state: "expired" }
  | { state: "soon"; daysLeft: number }
  | null;

export function describeAccessExpiry(
  status: { connected: boolean; accessExpiresAt: Date | null },
  now: Date,
): AccessExpiry {
  if (!status.connected || !status.accessExpiresAt) return null;

  const msLeft = status.accessExpiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return { state: "expired" };

  // Ceiling, not floor: "2 days" on the morning of the 9th for a token dying
  // on the evening of the 11th invites leaving it to the 11th. A token that
  // dies later today is "1 day", never "0 days".
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  return daysLeft <= WARN_WITHIN_DAYS ? { state: "soon", daysLeft } : null;
}

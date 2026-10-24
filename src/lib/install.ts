/**
 * Deciding whether to offer the install panel, and to whom.
 *
 * The browser half of installation cannot be tested without a real device, so
 * everything decidable from plain values is decided HERE, where a mistake is
 * caught by a test rather than by the owner finding a banner that will not go
 * away. The component holds only the parts that genuinely need a browser.
 *
 * The three platforms install differently and that difference is not cosmetic:
 * Chrome and Edge fire an event and open a native dialog, while iOS Safari has
 * no install API at all and can only be told what to tap.
 */

export type InstallPlatform = "ios" | "android" | "desktop";

/** How long a dismissal silences the panel. Long enough not to nag. */
export const DISMISS_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where the dismissal is remembered. Namespaced so it cannot collide. */
export const DISMISS_KEY = "tijarah.install.dismissedAt";

export function detectPlatform(env: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}): InstallPlatform {
  const ua = env.userAgent;

  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";

  // iPadOS 13+ sends a desktop Safari user agent and calls itself MacIntel.
  // Touch points are the only thing separating it from a real Mac, and getting
  // this wrong shows an iPad owner a Chrome install button iPadOS will never
  // honour.
  if (env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1) return "ios";

  if (/Android/i.test(ua)) return "android";

  // Desktop is the safe default: its panel is gated on a real install event,
  // so an unrecognised device shows nothing rather than wrong instructions.
  return "desktop";
}

/**
 * The display modes an app is ONLY in when it was installed.
 *
 * `display-mode` queries do not cascade: exactly one matches — the mode
 * actually applied — so asking about `standalone` alone misses an app running
 * as `minimal-ui` or `window-controls-overlay`, and the install panel then
 * reappears inside the installed app.
 *
 * `fullscreen` and `picture-in-picture` are deliberately absent: F11 on
 * Windows puts an ordinary tab in fullscreen and any video lightbox can enter
 * picture-in-picture, so either would silence the panel for someone who never
 * installed anything.
 */
export const INSTALLED_MEDIA_QUERY =
  "(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)";

export function isInstalled(env: {
  standaloneMedia: boolean;
  navigatorStandalone?: boolean;
}): boolean {
  // `navigator.standalone` is Safari's own, and older iOS reports no
  // display-mode at all, so both are consulted.
  return env.standaloneMedia || env.navigatorStandalone === true;
}

export function shouldOffer(input: {
  installed: boolean;
  dismissedAt: number | null;
  now: number;
  canPrompt: boolean;
  platform: InstallPlatform;
}): boolean {
  // An install banner inside the installed app is the most annoying failure
  // mode there is.
  if (input.installed) return false;

  if (input.dismissedAt !== null) {
    // A stamp in the future (clock change, hand-edited storage) is treated as
    // no stamp, rather than silencing the panel for eternity.
    const age = input.now - input.dismissedAt;
    if (age >= 0 && age < DISMISS_DAYS * DAY_MS) return false;
  }

  // Offered on every platform. `canPrompt` decides the CONTENT — a one-tap
  // button versus written instructions — never the visibility.
  //
  // Gating visibility on the browser's event was the first design here, and it
  // was wrong twice over: Safari never fires it at all, and a live check
  // against production saw Chrome not fire it either. Either way the owner
  // ends up with a laptop that is never offered the app it was asked to
  // offer. The panel shows; only its instructions differ.
  return true;
}

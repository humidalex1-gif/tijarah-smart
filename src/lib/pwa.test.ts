import { describe, it, expect } from "vitest";
import { buildManifest, APP_ICON_SVG, MASKABLE_ICON_SVG } from "./pwa";

/**
 * The installable app, on Android, Windows and iPhone, from one manifest.
 *
 * No store, no review, no second codebase: the owner opens the site and
 * installs it. That is the right shape for a private single-merchant tool,
 * and it is what stage 3 of the quick-entry design already called for.
 *
 * The rules below are the ones that decide whether an install SUCCEEDS or
 * silently falls back to a browser bookmark, so each is pinned rather than
 * trusted to a hand-written JSON file nobody re-reads.
 */

describe("buildManifest", () => {
  it("launches straight into quick entry in the requested locale", () => {
    const ar = buildManifest("ar");

    // The whole point of a phone icon on the home screen is one tap to the
    // entry screen. Landing on the marketing page or the dashboard would make
    // the install pointless.
    expect(ar.start_url).toBe("/ar/quick");
    expect(ar.scope).toBe("/");
    expect(buildManifest("en").start_url).toBe("/en/quick");
  });

  it("names the app in the language of the locale it was built for", () => {
    expect(buildManifest("ar").name).toBe("تجارة سمارت");
    expect(buildManifest("en").name).toBe("Tijarah Smart");
    // `short_name` is what fits under an icon; both stay under the ~12
    // characters Android and iOS truncate at.
    expect(buildManifest("ar").short_name!.length).toBeLessThanOrEqual(12);
    expect(buildManifest("en").short_name!.length).toBeLessThanOrEqual(12);
  });

  it("carries the reading direction, so Arabic installs are not mirrored wrongly", () => {
    expect(buildManifest("ar").dir).toBe("rtl");
    expect(buildManifest("ar").lang).toBe("ar");
    expect(buildManifest("en").dir).toBe("ltr");
  });

  it("declares standalone display, which is what removes the browser chrome", () => {
    const m = buildManifest("ar");

    expect(m.display).toBe("standalone");
    expect(m.display_override[0]).toBe("standalone");

    // `window-controls-overlay` is deliberately NOT requested. It hands the
    // app the title-bar strip to paint itself, and nothing here reads
    // `env(titlebar-area-*)`, so an installed Windows window would draw its
    // content under the caption buttons. It also broke the installed-app
    // check: display-mode queries do not cascade, so an app running in that
    // mode did not match `(display-mode: standalone)` and the install panel
    // reappeared inside the installed app.
    expect(m.display_override).not.toContain("window-controls-overlay");
    // Ending on `browser` keeps a device that supports none of the above on a
    // working page rather than refusing to open at all.
    expect(m.display_override.at(-1)).toBe("browser");
  });

  it("ships both a 192 and a 512 icon, the two sizes an install is refused without", () => {
    const sizes = buildManifest("ar").icons.map((i) => i.sizes);

    // Chrome's installability check requires 192 and 512. Missing either is
    // the single most common reason an "Install" prompt never appears.
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("provides a maskable icon as well as an any icon", () => {
    const purposes = buildManifest("ar").icons.map((i) => i.purpose);

    // Android crops icons to the device's shape. A non-maskable icon gets its
    // edges cut off; a maskable one keeps its artwork inside the safe circle.
    expect(purposes).toContain("maskable");
    expect(purposes).toContain("any");
  });

  it("uses the Swiss accent as the theme colour, matching the app itself", () => {
    const m = buildManifest("ar");

    // Yves Klein Blue — the same token the app paints with, so the installed
    // title bar does not announce a colour the product never uses.
    expect(m.theme_color).toBe("#002fa7");
    expect(m.background_color).toBe("#f4f4f5");
  });

  it("offers the expense entry as a shortcut, the one action worth a long-press", () => {
    const shortcuts = buildManifest("ar").shortcuts ?? [];

    expect(shortcuts.length).toBeGreaterThan(0);
    expect(shortcuts[0]!.url).toBe("/ar/quick");
  });
});

describe("icons", () => {
  it("draws real SVG, not a placeholder", () => {
    for (const svg of [APP_ICON_SVG, MASKABLE_ICON_SVG]) {
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("viewBox");
      expect(svg).toContain("#002fa7");
    }
  });

  it("keeps the maskable artwork inside the safe zone", () => {
    // Android may crop up to 20% from each edge. The plain icon fills its
    // canvas; the maskable one must not, or the mark loses its edges.
    expect(MASKABLE_ICON_SVG).toContain('width="512" height="512"');
    expect(MASKABLE_ICON_SVG).not.toBe(APP_ICON_SVG);
  });
});

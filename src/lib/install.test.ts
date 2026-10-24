import { describe, it, expect } from "vitest";
import {
  detectPlatform, isInstalled, shouldOffer, DISMISS_DAYS, INSTALLED_MEDIA_QUERY,
  type InstallPlatform,
} from "./install";

/**
 * Deciding WHETHER to offer the install panel, and to whom.
 *
 * Pure on purpose: the browser half of installation is untestable without a
 * real device, so everything that can be decided from plain values is decided
 * here, where a mistake is caught by a test instead of by the owner finding a
 * banner that will not go away.
 */

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  ipadOld: "Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ reports itself as a Mac. Only maxTouchPoints separates it.
  ipadModern: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

describe("detectPlatform", () => {
  it("knows an iPhone", () => {
    expect(detectPlatform({ userAgent: UA.iphone })).toBe("ios");
  });

  it("knows an older iPad that still says iPad", () => {
    expect(detectPlatform({ userAgent: UA.ipadOld })).toBe("ios");
  });

  it("knows a modern iPad, which lies and calls itself a Mac", () => {
    // iPadOS 13+ sends a desktop Safari UA. Treating it as a Mac shows the
    // owner a Chrome install button that iPadOS will never honour.
    expect(detectPlatform({
      userAgent: UA.ipadModern, platform: "MacIntel", maxTouchPoints: 5,
    })).toBe("ios");
  });

  it("does not mistake a real Mac for an iPad", () => {
    expect(detectPlatform({
      userAgent: UA.mac, platform: "MacIntel", maxTouchPoints: 0,
    })).toBe("desktop");
  });

  it("knows Android", () => {
    expect(detectPlatform({ userAgent: UA.android })).toBe("android");
  });

  it("treats Windows as desktop", () => {
    expect(detectPlatform({ userAgent: UA.windows })).toBe("desktop");
  });

  it("falls back to desktop for anything it cannot place", () => {
    // Desktop is the safe default: its panel is gated on a real install event,
    // so an unknown device shows nothing rather than wrong instructions.
    expect(detectPlatform({ userAgent: "" })).toBe("desktop");
  });
});

describe("INSTALLED_MEDIA_QUERY", () => {
  it("covers every display mode an installed app can actually run in", () => {
    // display-mode queries do NOT cascade: exactly one matches, the mode
    // actually applied. Asking only about `standalone` therefore misses an app
    // running as minimal-ui or window-controls-overlay, and the install panel
    // reappears INSIDE the installed app.
    expect(INSTALLED_MEDIA_QUERY).toContain("standalone");
    expect(INSTALLED_MEDIA_QUERY).toContain("minimal-ui");
    expect(INSTALLED_MEDIA_QUERY).toContain("window-controls-overlay");
  });

  it("excludes the two modes an ordinary browser tab can reach", () => {
    // F11 on Windows puts a plain tab in fullscreen, and any video lightbox
    // can enter picture-in-picture. Treating either as "installed" would
    // silence the panel for someone who never installed anything.
    expect(INSTALLED_MEDIA_QUERY).not.toContain("fullscreen");
    expect(INSTALLED_MEDIA_QUERY).not.toContain("picture-in-picture");
  });
});

describe("isInstalled", () => {
  it("believes the standalone display mode", () => {
    expect(isInstalled({ standaloneMedia: true })).toBe(true);
  });

  it("believes iOS's own flag, which has no display-mode of its own on older versions", () => {
    expect(isInstalled({ standaloneMedia: false, navigatorStandalone: true })).toBe(true);
  });

  it("is false in an ordinary browser tab", () => {
    expect(isInstalled({ standaloneMedia: false, navigatorStandalone: false })).toBe(false);
    expect(isInstalled({ standaloneMedia: false })).toBe(false);
  });
});

describe("shouldOffer", () => {
  const base = {
    installed: false, dismissedAt: null as number | null,
    now: Date.UTC(2026, 7, 19), canPrompt: true,
    platform: "android" as InstallPlatform,
  };

  it("never offers to an app that is already installed", () => {
    // The single most annoying failure mode: an install banner inside the
    // installed app.
    expect(shouldOffer({ ...base, installed: true })).toBe(false);
    expect(shouldOffer({ ...base, installed: true, platform: "ios" })).toBe(false);
  });

  it("offers on every platform, with or without the browser's install event", () => {
    // The owner asked to be offered the app on laptop, Android and iPhone.
    // Chrome's event is late or absent often enough — it never fired at all
    // in a live check against production — that gating the PANEL on it would
    // mean the laptop is simply never offered anything.
    //
    // What the event decides is the CONTENT, not the visibility: a one-tap
    // button when the browser will honour it, written instructions when it
    // will not. That way there is never a button that opens nothing, and
    // never a platform left silent.
    for (const platform of ["ios", "android", "desktop"] as InstallPlatform[]) {
      expect(shouldOffer({ ...base, platform, canPrompt: true })).toBe(true);
      expect(shouldOffer({ ...base, platform, canPrompt: false })).toBe(true);
    }
  });

  it("stays quiet for a while after being dismissed", () => {
    const dismissedAt = base.now - 1000;
    expect(shouldOffer({ ...base, dismissedAt })).toBe(false);
  });

  it("asks again only after the dismissal has aged out", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const justInside = base.now - (DISMISS_DAYS * dayMs) + 60_000;
    const wellPast = base.now - (DISMISS_DAYS * dayMs) - 60_000;

    expect(shouldOffer({ ...base, dismissedAt: justInside })).toBe(false);
    expect(shouldOffer({ ...base, dismissedAt: wellPast })).toBe(true);
  });

  it("ignores a dismissal stamped in the future instead of hiding forever", () => {
    // A clock change or a hand-edited value must not silence the panel for
    // eternity; an impossible stamp is treated as no stamp.
    expect(shouldOffer({ ...base, dismissedAt: base.now + 5 * 60 * 60 * 1000 })).toBe(true);
  });
});

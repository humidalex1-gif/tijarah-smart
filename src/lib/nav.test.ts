import { describe, it, expect } from "vitest";
import { NAV_ITEMS, activeNavKey, APP_HOME, appHomePath } from "@/lib/nav";
import { getTranslator } from "@/lib/i18n";

describe("activeNavKey", () => {
  it("reads the nav key from the first segment after the locale", () => {
    expect(activeNavKey("/en/products", "en")).toBe("products");
    expect(activeNavKey("/ar/warehouses", "ar")).toBe("warehouses");
  });

  it("resolves the screens added by the Salla/3PL pivot", () => {
    // The regression this guards: these four lived only in the sidebar's own
    // list, so the layout fell through to "dashboard" and every one of them
    // rendered the header title and the nav highlight of the dashboard.
    expect(activeNavKey("/en/reconcile", "en")).toBe("reconcile");
    expect(activeNavKey("/en/claims", "en")).toBe("claims");
    expect(activeNavKey("/en/adspend", "en")).toBe("adspend");
    expect(activeNavKey("/en/profit", "en")).toBe("profit");
  });

  it("keeps the deepest link on a section highlighted by its section", () => {
    expect(activeNavKey("/en/products/abc/edit", "en")).toBe("products");
  });

  it("falls back to the dashboard for the locale root and for unknown paths", () => {
    expect(activeNavKey("/en", "en")).toBe("dashboard");
    expect(activeNavKey("/en/", "en")).toBe("dashboard");
    expect(activeNavKey("/en/not-a-section", "en")).toBe("dashboard");
  });
});

describe("nav items", () => {
  // The drift that caused the bug above was two hand-maintained lists. This
  // fails the moment a sidebar entry is added without the resolver knowing it.
  it("resolves every sidebar entry back to its own key", () => {
    for (const item of NAV_ITEMS) {
      const path = `/en${item.href ? `/${item.href}` : ""}`;
      expect(activeNavKey(path, "en")).toBe(item.key);
    }
  });

  it("gives the dashboard a real segment, because the locale root is the landing page", () => {
    // The dashboard was the index until the public front door needed that
    // path. Anything still sending a signed-in owner to `/[locale]` now lands
    // them on marketing copy instead of their figures.
    expect(NAV_ITEMS.find((item) => item.key === "dashboard")?.href).toBe("dashboard");
    expect(activeNavKey("/en/dashboard", "en")).toBe("dashboard");
  });

  it("puts quick entry in the list, and puts it first", () => {
    // The page exists to be reached in one tap on a phone. Anywhere but first
    // and the tap becomes a scroll, which is the thing it was built to remove.
    expect(NAV_ITEMS.map((item) => item.key)).toContain("quick");
    expect(NAV_ITEMS[0]?.key).toBe("quick");
  });

  it("resolves /quick to its own key, not to the dashboard", () => {
    // The drift that hit four screens after the pivot: present in the sidebar,
    // unknown to the resolver, so the header title and the highlight both fell
    // through to the dashboard. Asserted under /ar because that is the default
    // locale and the one the owner actually uses.
    expect(activeNavKey("/ar/quick", "ar")).toBe("quick");
    expect(activeNavKey("/en/quick", "en")).toBe("quick");
  });

  it("has a label in both catalogues for every entry", async () => {
    const en = await getTranslator("en");
    const ar = await getTranslator("ar");
    for (const item of NAV_ITEMS) {
      expect(en(`nav.${item.key}`), `en nav.${item.key}`).not.toBe(`nav.${item.key}`);
      expect(ar(`nav.${item.key}`), `ar nav.${item.key}`).not.toBe(`nav.${item.key}`);
    }
  });
});

/**
 * Where the app opens after the owner enters it.
 *
 * One definition, because four places need the same answer — the login
 * redirect, the landing page's call to action, the installed app's
 * `start_url`, and the menu's own first entry — and this project has already
 * shipped a bug caused by two hand-maintained lists that were supposed to
 * agree and quietly stopped agreeing.
 */
describe("app home", () => {
  it("opens on whatever the menu puts first, so the two cannot drift", () => {
    expect(APP_HOME).toBe(NAV_ITEMS[0]?.key);
  });

  it("is a real destination, not a key nothing resolves", () => {
    expect(activeNavKey(appHomePath("ar"), "ar")).toBe(APP_HOME);
    expect(activeNavKey(appHomePath("en"), "en")).toBe(APP_HOME);
  });

  it("builds a locale-correct path", () => {
    expect(appHomePath("ar")).toBe("/ar/quick");
    expect(appHomePath("en")).toBe("/en/quick");
  });

  it("is NOT the dashboard, which stays the fallback for a refused screen", () => {
    // `requirePermission` bounces a denial to the dashboard. Pointing that
    // fallback at the home path would loop forever for anyone who cannot open
    // it, so the two must stay different destinations.
    expect(APP_HOME).not.toBe("dashboard");
  });
});

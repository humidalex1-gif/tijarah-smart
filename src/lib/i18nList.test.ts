import { describe, it, expect } from "vitest";
import { getList } from "./i18n";

/**
 * Reading a LIST of strings from the catalogues.
 *
 * `getTranslator` resolves a key to one string, and a dictionary node that is
 * an array falls through its plural check and comes back as the key itself —
 * so an ordered set of steps had nowhere to live until now. The install
 * panel's per-platform instructions are exactly that.
 */

describe("getList", () => {
  it("returns the install steps in order, in both catalogues", async () => {
    const ar = await getList("ar", "install.iosSteps");
    const en = await getList("en", "install.iosSteps");

    expect(ar).toHaveLength(3);
    expect(en).toHaveLength(3);
    expect(ar[0]).toContain("Safari");
    expect(en[0]).toContain("Share");
  });

  it("keeps the three platforms distinct, so no device is told another's steps", async () => {
    const ios = await getList("ar", "install.iosSteps");
    const android = await getList("ar", "install.androidSteps");
    const desktop = await getList("ar", "install.desktopSteps");

    expect(ios).not.toEqual(android);
    expect(android).not.toEqual(desktop);
    expect(desktop).not.toEqual(ios);
  });

  it("returns an empty list for a missing key rather than throwing", async () => {
    // Same miss-is-visible posture as `getTranslator`: a gap shows as absent
    // instructions, never as a crashed layout on every page of the app.
    expect(await getList("ar", "install.doesNotExist")).toEqual([]);
    expect(await getList("ar", "nope.nope.nope")).toEqual([]);
  });

  it("returns an empty list when the key holds a string, not a list", async () => {
    expect(await getList("ar", "install.title")).toEqual([]);
  });

  it("drops non-string entries instead of rendering undefined", async () => {
    expect(await getList("ar", "dashboard.orders")).toEqual([]);
  });
});

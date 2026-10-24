import { describe, it, expect } from "vitest";
import { AD_CHANNELS } from "@/lib/constants";
import { getTranslator } from "@/lib/i18n";

/**
 * The channel is stored as a bare enum (`META`, `OTHER`, …) and was rendered
 * straight to screen in both languages — a block of Latin capitals under an
 * Arabic label, and the project's rule that every user-facing string comes
 * from both catalogues quietly broken.
 */
describe("advertising channel labels", () => {
  it("has a label for every channel in both catalogues", async () => {
    const en = await getTranslator("en");
    const ar = await getTranslator("ar");

    for (const channel of AD_CHANNELS) {
      const key = `adspend.channels.${channel}`;
      // The translator returns the key itself when a key is missing.
      expect(en(key), `en ${key}`).not.toBe(key);
      expect(ar(key), `ar ${key}`).not.toBe(key);
    }
  });

  it("translates OTHER rather than leaving it as an English word", async () => {
    const ar = await getTranslator("ar");
    expect(ar("adspend.channels.OTHER")).toBe("أخرى");
  });

  it("keeps the platform names recognisable rather than transliterating them", async () => {
    // Saudi advertisers refer to these by their Latin brand names; the fix here
    // is the SHOUTING, not the alphabet.
    const ar = await getTranslator("ar");
    expect(ar("adspend.channels.META")).toBe("Meta");
    expect(ar("adspend.channels.SNAPCHAT")).toBe("Snapchat");
  });
});

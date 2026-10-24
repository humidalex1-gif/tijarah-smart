import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The gradient that fills TEXT must stay readable, in both themes.
 *
 * Measured, not eyeballed. The brand gradient is tuned for white-on-colour —
 * buttons, icon tiles, the split bar — where it is the ground and passes
 * easily. Used the other way round, as coloured text on the page's near-white
 * ground, its own stops land at 2.27–2.94:1, under the 3:1 floor for large
 * text. The page shipped that way on its loss figure and its step numerals.
 *
 * So a second gradient exists for text only: same three hues, walked darker
 * for the light theme and left bright for the dark one. This test is what
 * stops someone "simplifying" the two back into one.
 */

const CSS = readFileSync("src/app/[locale]/(marketing)/landing.css", "utf8");

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const parts = hex.replace("#", "").match(/../g)!.map((h) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0]! + 0.7152 * parts[1]! + 0.0722 * parts[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Every `#rrggbb` inside the named custom property's value. */
function stopsOf(property: string, occurrence = 0): string[] {
  const matches = [...CSS.matchAll(new RegExp(`${property}:([^;]+);`, "g"))];
  const value = matches[occurrence]?.[1] ?? "";
  return [...value.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
}

const LIGHT_BG = "#f6f9fc";
const DARK_BG = "#0b1424";

describe("landing text gradient", () => {
  it("is defined separately from the surface gradient", () => {
    // One gradient cannot serve both: what reads well as a ground behind white
    // text is too pale to BE the text.
    expect(stopsOf("--tj-grad-text")).toHaveLength(3);
  });

  it("clears the body-text contrast floor on the light ground", () => {
    for (const stop of stopsOf("--tj-grad-text", 0)) {
      expect(contrast(stop, LIGHT_BG), `${stop} on ${LIGHT_BG}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("clears it on the dark ground too, where the stops differ", () => {
    const darkStops = stopsOf("--tj-grad-text", 1);
    expect(darkStops).toHaveLength(3);
    for (const stop of darkStops) {
      expect(contrast(stop, DARK_BG), `${stop} on ${DARK_BG}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the bright surface gradient, which is never used as text", () => {
    // Unchanged brand: buttons, the icon tiles and the split bar still carry
    // the owner's original blue -> teal -> green.
    const surface = stopsOf("--tj-grad");
    expect(surface).toEqual([]);
    expect(CSS).toContain("var(--tj-blue), var(--tj-teal) 55%, var(--tj-green)");
    expect(CSS).toContain("--tj-blue: #2e9bd4");
    expect(CSS).toContain("--tj-green: #2fbf63");
  });
});

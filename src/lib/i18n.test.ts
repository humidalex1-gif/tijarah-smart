import { describe, it, expect } from "vitest";
import { isLocale, dirFor, getTranslator, isPluralNode, getDictionary } from "@/lib/i18n";

describe("locales", () => {
  it("recognises the supported locales only", () => {
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  it("maps Arabic to RTL and English to LTR", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });
});

describe("translator", () => {
  it("looks up dotted keys in the requested language", async () => {
    const en = await getTranslator("en");
    const ar = await getTranslator("ar");
    expect(en("nav.dashboard")).toBe("Dashboard");
    expect(ar("nav.dashboard")).toBe("لوحة التحكم");
  });

  it("interpolates variables", async () => {
    const en = await getTranslator("en");
    expect(en("inventory.insufficient", { product: "Widget", available: 3 }))
      .toContain("Widget");
    expect(en("inventory.insufficient", { product: "Widget", available: 3 }))
      .toContain("3");
  });

  it("returns the key itself when a translation is missing", async () => {
    const en = await getTranslator("en");
    expect(en("does.not.exist")).toBe("does.not.exist");
  });

  it("has the same key set in both languages", async () => {
    const { getDictionary } = await import("@/lib/i18n");
    // A plural node (see `isPluralNode`) is deliberately exempt from the
    // category-by-category comparison: each language declares only the CLDR
    // cardinal categories it actually distinguishes (English: one/other;
    // Arabic: all six), so requiring identical child keys under a plural
    // node would fail on that intentional difference rather than catch a
    // real gap. The node's own key path is still required in both — that's
    // the meaningful parity check (every plural message exists in both
    // catalogs; only its internal category shape is allowed to diverge).
    const flatten = (obj: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(obj).flatMap(([k, v]) => {
        const path = `${prefix}${k}`;
        if (isPluralNode(v)) return [path];
        return typeof v === "object" && v !== null
          ? flatten(v as Record<string, unknown>, `${path}.`)
          : [path];
      });

    const en = flatten(await getDictionary("en"));
    const ar = flatten(await getDictionary("ar"));
    expect(en.filter((k) => !ar.includes(k))).toEqual([]);
    expect(ar.filter((k) => !en.includes(k))).toEqual([]);
  });

  it("declares, for every plural node, at least the CLDR cardinal categories its own language's rule requires", async () => {
    // Two gaps this closes together:
    //  (a) `isPluralNode` classifies ANY object whose keys are all category
    //      names as a plural node — a plausible non-plural label object like
    //      `{ other: "Other" }` would be misclassified and silently exempted
    //      from the key-parity check above. Requiring the node's keys to be a
    //      *superset* of the language's required categories makes that
    //      self-limiting: `{ other: "Other" }` only satisfies English's
    //      `one`/`other` requirement if `one` is also present.
    //  (b) Nothing previously asserted a language actually declares the
    //      categories its own CLDR rule needs — Arabic could ship only
    //      `{ other }` and pass, then render the ungrammatical "٣ طلب"
    //      instead of "٣ طلبات" at runtime — exactly the bug the plural work
    //      removed.
    const collectPluralNodes = (
      obj: Record<string, unknown>,
      prefix = "",
    ): Array<{ path: string; keys: string[] }> =>
      Object.entries(obj).flatMap(([k, v]) => {
        const path = `${prefix}${k}`;
        if (isPluralNode(v)) return [{ path, keys: Object.keys(v) }];
        return typeof v === "object" && v !== null
          ? collectPluralNodes(v as Record<string, unknown>, `${path}.`)
          : [];
      });

    for (const locale of ["en", "ar"] as const) {
      const dictionary = await getDictionary(locale);
      const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const { path, keys } of collectPluralNodes(dictionary)) {
        for (const category of required) {
          expect(
            keys,
            `${locale} plural node "${path}" is missing required CLDR category "${category}" (has: ${keys.join(", ")})`,
          ).toContain(category);
        }
      }
    }
  });
});

describe("pluralization", () => {
  it("selects English one/other correctly", async () => {
    const en = await getTranslator("en");
    expect(en("dashboard.orders", { count: 1 })).toBe("1 order");
    expect(en("dashboard.orders", { count: 2 })).toBe("2 orders");
  });

  it("selects Arabic's six cardinal categories correctly", async () => {
    const ar = await getTranslator("ar");
    expect(ar("dashboard.orders", { count: 1 })).toBe("طلب واحد");
    expect(ar("dashboard.orders", { count: 2 })).toBe("طلبان");
    // 3 and 11 render with Arabic-Indic digits (٣ / ١١), matching
    // `formatNumber`'s locale-correct digit rendering for `count`.
    expect(ar("dashboard.orders", { count: 3 })).toBe("٣ طلبات");
    expect(ar("dashboard.orders", { count: 11 })).toBe("١١ طلبًا");
  });

  it("falls back to the other category when count is missing or non-numeric", async () => {
    const en = await getTranslator("en");
    expect(en("dashboard.orders")).toBe("{count} orders");
    expect(en("dashboard.orders", { count: "5" })).toBe("5 orders");
  });
});

import { formatNumber } from "@/lib/format";

export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ar";

export type Dictionary = Record<string, unknown>;

// The full CLDR cardinal-plural category set. No language uses all six —
// English only ever needs `one`/`other`; Arabic's cardinal rule needs all
// six (`zero`: 0, `one`: 1, `two`: 2, `few`: 3-10, `many`: 11-99, `other`:
// everything else, e.g. 100+). See `isPluralNode` below.
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

const cache = new Map<Locale, Dictionary>();

export async function getDictionary(locale: Locale): Promise<Dictionary> {
  const cached = cache.get(locale);
  if (cached) return cached;

  const dictionary = locale === "ar"
    ? (await import("../../messages/ar.json")).default
    : (await import("../../messages/en.json")).default;

  cache.set(locale, dictionary as Dictionary);
  return dictionary as Dictionary;
}

function lookupNode(dictionary: Dictionary, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) =>
      node && typeof node === "object" ? (node as Dictionary)[part] : undefined,
    dictionary,
  );
}

/**
 * A "plural node" is a dictionary entry whose value is an object of
 * per-category variants (e.g. `{ one: "{count} order", other: "{count}
 * orders" }`) instead of a single string — used for any message that
 * interpolates a `count` and therefore needs grammatically correct
 * pluralization rather than raw `{var}` substitution (a plain English "s"
 * suffix is wrong for "1 orders", and wrong again in Arabic, whose cardinal
 * rule has six categories, not two). A dictionary may declare only the
 * categories its language's CLDR cardinal rule actually distinguishes.
 *
 * Exported so `i18n.test.ts`'s key-parity check can treat a plural node's
 * *category keys* as intentionally language-specific (English needs
 * `one`/`other`; Arabic needs all six) while still requiring the node
 * itself to exist under the same key path in both catalogs.
 */
export function isPluralNode(value: unknown): value is Partial<Record<PluralCategory, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => (PLURAL_CATEGORIES as readonly string[]).includes(k));
}

/**
 * Reads an ordered LIST of strings from the catalogues.
 *
 * `getTranslator` resolves a key to one string, and an array node falls
 * through its plural check to come back as the key itself — so a sequence of
 * steps (the install instructions, which differ per platform) had nowhere to
 * live. Same miss-is-visible posture as the rest of this module: a missing or
 * wrongly-shaped key yields an empty list, never a throw, because this is read
 * from the root layout and a crash there takes down every page in the app.
 */
export async function getList(locale: Locale, key: string): Promise<string[]> {
  const node = lookupNode(await getDictionary(locale), key);
  if (!Array.isArray(node)) return [];
  return node.filter((item): item is string => typeof item === "string");
}

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

export async function getTranslator(locale: Locale): Promise<Translator> {
  const dictionary = await getDictionary(locale);
  const pluralRules = new Intl.PluralRules(locale);

  return (key, vars) => {
    const node = lookupNode(dictionary, key);
    const template = resolveTemplate(node, key, vars, pluralRules);
    if (!vars) return template;

    return Object.entries(vars).reduce((text, [name, value]) => {
      // `count` specifically gets locale-correct digits (Arabic renders
      // Arabic-Indic numerals) via `formatNumber`, since it's also the value
      // `Intl.PluralRules` just selected a category from — every other `{var}`
      // keeps the caller's own pre-formatted string (see `format.ts`'s
      // `formatNumber` doc comment for why a bare number would be wrong there
      // too, but that's on the caller for non-count vars).
      const display = name === "count" && typeof value === "number"
        ? formatNumber(value, locale)
        : String(value);
      return text.replaceAll(`{${name}}`, display);
    }, template);
  };
}

/**
 * Client-side counterpart to `Translator`'s own `{var}` substitution, for a
 * message a Client Component fills in with values only known after the user
 * has typed them (a confirmation dialog's impact message). A `Translator`
 * closure cannot cross the server/client boundary as a prop — Next requires
 * props from a Server Component to a Client Component to be serializable —
 * so the page resolves the raw template server-side via `t(key)` with NO
 * `vars` (which returns the template unfilled, `{qty}`/`{product}`/...
 * placeholders intact) and hands that plain string down; the Client
 * Component fills it in with this. Plain substitution only, no
 * pluralization — every caller of this passes already-formatted display
 * strings (via `formatQty`/`formatNumber`/etc.), matching the non-`count`
 * branch of `getTranslator`'s own interpolation.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
}

function resolveTemplate(
  node: unknown,
  key: string,
  vars: Record<string, string | number> | undefined,
  pluralRules: Intl.PluralRules,
): string {
  if (typeof node === "string") return node;

  if (isPluralNode(node)) {
    const count = vars?.count;
    // A plural node needs a numeric `count` to select a category; anything
    // else (missing, or a pre-formatted string) falls back to "other" rather
    // than throwing, matching the rest of this module's miss-is-visible,
    // never-crash posture.
    const category = typeof count === "number" ? pluralRules.select(count) : "other";
    return node[category] ?? node.other ?? key;
  }

  // A missing key (or an object that isn't a recognized plural node) returns
  // the key itself, so gaps are obvious on screen instead of blank space.
  return key;
}

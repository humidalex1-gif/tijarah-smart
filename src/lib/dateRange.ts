import type { DateRange } from "@/services/reporting";
import type { Locale } from "@/lib/i18n";

/** Requirements doc 02 §5.8's dashboard date-range control. */
export const RANGE_KEYS = [
  "today", "yesterday", "7d", "30d", "month", "lastMonth", "year", "custom",
] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Upper bound on a `custom` range's span, inclusive of both endpoints.
 * Without this, `?range=custom&from=1900-01-01&to=2099-01-01` makes
 * `salesSeries` iterate one day at a time across ~73,000 days and emit a
 * chart path with as many points. 366 covers a full leap year, which is
 * generous for a dashboard range picker.
 */
const MAX_RANGE_DAYS = 366;

function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

function firstValue(searchParams: SearchParams, key: string): string | undefined {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function startOfUtcDay(date: Date): Date {
  return utcDay(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addDays(date: Date, days: number): Date {
  return utcDay(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

function parseIsoDay(value: string | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = utcDay(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolves the dashboard's selected date range from `?range=` (and, for
 * `custom`, `?from=&to=`, both `YYYY-MM-DD`). Defaults to `30d` when `range`
 * is missing or unrecognized. All arithmetic is UTC-day granularity, matching
 * `services/reporting.ts`'s `dayWindow` so the range selected here filters
 * exactly the orders the reporting queries include.
 *
 * `locale` is accepted (not currently used) to match every other formatting
 * entry point in this codebase taking the caller's locale explicitly — kept
 * for a future locale-aware label/week-start without changing the signature.
 */
export function parseRange(
  searchParams: SearchParams,
  locale: Locale,
): DateRange & { key: RangeKey } {
  void locale;

  const requested = firstValue(searchParams, "range");
  const key = isRangeKey(requested) ? requested : "30d";
  const today = startOfUtcDay(new Date());

  switch (key) {
    case "today":
      return { from: today, to: today, key };
    case "yesterday": {
      const day = addDays(today, -1);
      return { from: day, to: day, key };
    }
    case "7d":
      return { from: addDays(today, -6), to: today, key };
    case "30d":
      return { from: addDays(today, -29), to: today, key };
    case "month":
      return { from: utcDay(today.getUTCFullYear(), today.getUTCMonth(), 1), to: today, key };
    case "lastMonth": {
      const firstOfThisMonth = utcDay(today.getUTCFullYear(), today.getUTCMonth(), 1);
      const to = addDays(firstOfThisMonth, -1);
      const from = utcDay(to.getUTCFullYear(), to.getUTCMonth(), 1);
      return { from, to, key };
    }
    case "year":
      return { from: utcDay(today.getUTCFullYear(), 0, 1), to: today, key };
    case "custom": {
      const fromRaw = parseIsoDay(firstValue(searchParams, "from")) ?? addDays(today, -29);
      const toRaw = parseIsoDay(firstValue(searchParams, "to")) ?? today;
      // Cap BOTH endpoints at today before the inverted-range clamp below.
      // Capping only `to` still let a future `from` through: with no `to`
      // given, `to` defaults to today, but the inversion clamp below then
      // sets `to = from` whenever `from` is later than `to` — so an
      // uncapped future `from` (e.g. `?from=2099-01-01` with no `to`) was
      // smuggled through as `to` too, producing a future window instead of
      // being rejected.
      const fromCapped = fromRaw.getTime() > today.getTime() ? today : fromRaw;
      const toCapped = toRaw.getTime() > today.getTime() ? today : toRaw;
      const to = toCapped.getTime() < fromCapped.getTime() ? fromCapped : toCapped;
      // Bound the span by pulling `from` forward rather than pushing `to`
      // back — `to` is the endpoint the caller (and the "as of" reading of
      // the dashboard) cares most about preserving.
      const earliestAllowed = addDays(to, -(MAX_RANGE_DAYS - 1));
      const boundedFrom = fromCapped.getTime() < earliestAllowed.getTime()
        ? earliestAllowed
        : fromCapped;
      return { from: boundedFrom, to, key };
    }
  }
}

import { fromMinor, fromQty } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

const localeTag = (locale: Locale) => (locale === "ar" ? "ar-SA" : "en-US");

// `currency` is required on purpose: onboarding collects `Company.currencyCode`,
// so no screen may assume SAR.
export function formatMoney(minor: number, locale: Locale, currency: string): string {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(fromMinor(minor));
}

// Locale-correct digits for a plain count (order counts, low-stock item
// counts, …) — anything that isn't a stored money/qty scaled integer.
// `Translator`'s `{var}` interpolation is a raw String(value), so a number
// var must be pre-formatted through this before being passed to `t()`, or
// Arabic renders Western digits.
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

export function formatQty(qty: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(fromQty(qty));
}

// The distinction that decides whether a caller pins `timeZone: "UTC"` is
// INSTANT-IN-TIME WALL CLOCK vs. BUSINESS DAY — not, as this comment used to
// say, "Date vs. day-key string". Both this function and
// `formatBusinessDate` below take a `Date`; they render it differently on
// purpose:
//   - `formatDate` (no `timeZone` pinned): for a real instant — e.g. an
//     audit timestamp like `createdAt`/`updatedAt` — where "when did this
//     actually happen" means the viewer's own wall clock. Correct for that
//     case, wrong for a business-date column (see `formatBusinessDate`).
//   - `formatBusinessDate` (`timeZone: "UTC"` pinned): for a business-date
//     column — `orderDate`, `expenseDate`, `receivedDate`, `paymentDate`,
//     `transferDate`, … — that the reporting layer buckets by UTC day
//     (`services/reporting.ts`'s `dayWindow`) regardless of the timestamp's
//     time-of-day component. Use that one for those columns; using this one
//     instead would render an order stamped 22:00 UTC as the day AFTER the
//     day the dashboard KPIs counted it under for any viewer east of UTC
//     (and the day before, for any viewer west of it around midnight UTC).
//
// Call sites: products/page.tsx's `updatedAt` column and
// settings/team/page.tsx's `lastLoginAt` column — both real instants (not
// business-date columns bucketed by UTC day), so the viewer's own wall clock
// is correct for them. `lastLoginAt` used to go through
// `formatBusinessDateTime` instead (Stage 1B review, minors) — an instant
// rendered with the UTC pin meant for a business-date column.
export function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric", month: "short", day: "numeric",
  }).format(date);
}

// THE formatter for business-date columns — see `formatDate`'s comment
// immediately above for the full instant-vs-business-day distinction this
// draws. `orderDate`, `expenseDate`, `receivedDate`, `paymentDate`,
// `transferDate`, and any other column the reporting layer treats as a UTC
// day must render through this, not `formatDate`, so a sales/expense/etc.
// list never contradicts the dashboard KPI that counted the same row under
// a different calendar day.
export function formatBusinessDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  }).format(date);
}

// Same UTC pin as `formatBusinessDate`, plus hour/minute — for a log-style
// business-date column where several events can land on the same UTC day
// and the merchant needs to tell them apart, e.g. `InventoryMovement`'s
// movements list/detail tables (a receive and an issue in the same shift
// share a calendar day; only the time distinguishes their order). The hour/
// minute must be the UTC hour/minute for the same reason `formatBusinessDate`
// pins UTC at all: a viewer's local wall-clock time would put the SAME
// movement in a different position relative to others on a shared UTC day
// boundary depending on where the browser/server clock is set.
export function formatBusinessDateTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }).format(date);
}

// `reporting.ts`'s `dayKey()`/`salesSeries` produce plain `"YYYY-MM-DD"`
// day-keys with no wall-clock component, parsed as UTC midnight by `new
// Date(key)`. Formatting that with `formatDate` (no `timeZone` pinned) renders
// in the *viewer's* runtime zone, so anyone west of UTC sees the label for
// the day BEFORE the day the value was actually aggregated for. Pin
// `timeZone: "UTC"` explicitly so the label always names the same calendar
// day the key encodes, regardless of where the browser/server clock is set.
// (Same UTC pin as `formatBusinessDate` above, kept as a separate function
// because the input shape differs — a day-key string here vs. a `Date`
// there — not because the underlying rule differs.)
export function formatDayKey(key: string, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(key));
}

export function formatPct(basisPoints: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(basisPoints / 10_000);
}

// Compact axis-tick variant of formatMoney (e.g. "SAR 12K") — full formatMoney
// is too wide for a chart's y-axis gutter. Only for chart ticks/tooltips;
// every other money display on screen still goes through formatMoney/<Money>.
export function formatMoneyCompact(minor: number, locale: Locale, currency: string): string {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(fromMinor(minor));
}

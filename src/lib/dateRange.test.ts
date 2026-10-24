import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRange } from "@/lib/dateRange";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("parseRange", () => {
  beforeEach(() => {
    // Wednesday — mid-month, mid-year, so month/year/lastMonth boundaries
    // are all meaningfully different from "today".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T18:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to a 30-day trailing window when range is missing", () => {
    const range = parseRange({}, "en");
    expect(range.key).toBe("30d");
    expect(iso(range.from)).toBe("2026-06-16");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("defaults to 30d for an unrecognized range value", () => {
    const range = parseRange({ range: "bogus" }, "en");
    expect(range.key).toBe("30d");
  });

  it("resolves today", () => {
    const range = parseRange({ range: "today" }, "en");
    expect(iso(range.from)).toBe("2026-07-15");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("resolves yesterday", () => {
    const range = parseRange({ range: "yesterday" }, "en");
    expect(iso(range.from)).toBe("2026-07-14");
    expect(iso(range.to)).toBe("2026-07-14");
  });

  it("resolves 7d as a trailing 7-day window including today", () => {
    const range = parseRange({ range: "7d" }, "en");
    expect(iso(range.from)).toBe("2026-07-09");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("resolves month as month-to-date", () => {
    const range = parseRange({ range: "month" }, "en");
    expect(iso(range.from)).toBe("2026-07-01");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("resolves lastMonth as the full previous calendar month", () => {
    const range = parseRange({ range: "lastMonth" }, "en");
    expect(iso(range.from)).toBe("2026-06-01");
    expect(iso(range.to)).toBe("2026-06-30");
  });

  it("resolves lastMonth correctly across a January year boundary", () => {
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    const range = parseRange({ range: "lastMonth" }, "en");
    expect(iso(range.from)).toBe("2025-12-01");
    expect(iso(range.to)).toBe("2025-12-31");
  });

  it("resolves year as year-to-date", () => {
    const range = parseRange({ range: "year" }, "en");
    expect(iso(range.from)).toBe("2026-01-01");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("resolves custom from ?from=&to=", () => {
    const range = parseRange({ range: "custom", from: "2026-05-01", to: "2026-05-10" }, "en");
    expect(range.key).toBe("custom");
    expect(iso(range.from)).toBe("2026-05-01");
    expect(iso(range.to)).toBe("2026-05-10");
  });

  it("falls back to a 30-day window when custom is missing from/to", () => {
    const range = parseRange({ range: "custom" }, "en");
    expect(iso(range.from)).toBe("2026-06-16");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("clamps an inverted custom range so to never precedes from", () => {
    const range = parseRange({ range: "custom", from: "2026-05-10", to: "2026-05-01" }, "en");
    expect(iso(range.from)).toBe("2026-05-10");
    expect(iso(range.to)).toBe("2026-05-10");
  });

  it("ignores malformed custom dates and falls back to defaults", () => {
    const range = parseRange({ range: "custom", from: "not-a-date", to: "also-bad" }, "en");
    expect(iso(range.from)).toBe("2026-06-16");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("clamps a future custom `to` to today", () => {
    const range = parseRange({ range: "custom", from: "2026-07-01", to: "2099-01-01" }, "en");
    expect(iso(range.from)).toBe("2026-07-01");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("caps a future custom `from` (no `to` given) instead of smuggling a future window through the inversion clamp", () => {
    // Before the fix: `to` defaults to today (2026-07-15), then the
    // inversion clamp sees `from` (2099-01-01) is later than `to` and sets
    // `to = from`, producing a 1-day window in 2099 — a future window slips
    // past the "clamps a future `to`" guard above because only `to` was
    // capped, not `from`.
    const range = parseRange({ range: "custom", from: "2099-01-01" }, "en");
    expect(iso(range.from)).toBe("2026-07-15");
    expect(iso(range.to)).toBe("2026-07-15");
  });

  it("bounds an enormous custom span to MAX_RANGE_DAYS by pulling `from` forward", () => {
    const range = parseRange({ range: "custom", from: "1900-01-01", to: "2099-01-01" }, "en");
    // `to` still clamps to today; `from` is pulled forward to keep the span
    // at 366 days inclusive instead of the ~73,000 days a raw 1900-2099
    // span would otherwise produce (and `salesSeries` would iterate).
    expect(iso(range.to)).toBe("2026-07-15");
    expect(iso(range.from)).toBe("2025-07-15");
    const spanDays = Math.round(
      (range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000),
    ) + 1;
    expect(spanDays).toBe(366);
  });

  it("takes the first value when a param is duplicated in the query string", () => {
    const range = parseRange({ range: ["today", "year"] }, "en");
    expect(range.key).toBe("today");
  });

  it("is unaffected by locale", () => {
    const en = parseRange({ range: "month" }, "en");
    const ar = parseRange({ range: "month" }, "ar");
    expect(iso(en.from)).toBe(iso(ar.from));
    expect(iso(en.to)).toBe(iso(ar.to));
  });
});

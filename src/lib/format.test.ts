import { describe, it, expect, afterEach } from "vitest";
import { toMinor, toQty } from "@/lib/money";
import {
  formatMoney, formatQty, formatPct, formatDayKey, formatBusinessDate, formatBusinessDateTime, formatDate,
} from "@/lib/format";

describe("formatMoney", () => {
  it("renders minor units as a currency amount", () => {
    expect(formatMoney(toMinor(1234.5), "en", "SAR")).toContain("1,234.50");
  });

  it("renders zero and negatives", () => {
    expect(formatMoney(0, "en", "SAR")).toContain("0.00");
    expect(formatMoney(toMinor(-50), "en", "SAR")).toContain("50.00");
  });
});

describe("formatQty", () => {
  it("drops trailing zeros on whole quantities", () => {
    expect(formatQty(toQty(5), "en")).toBe("5");
  });

  it("keeps meaningful decimals", () => {
    expect(formatQty(toQty(2.5), "en")).toBe("2.5");
    expect(formatQty(toQty(0.125), "en")).toBe("0.125");
  });
});

describe("formatPct", () => {
  it("renders hundredths of a percent as a percentage", () => {
    expect(formatPct(1500, "en")).toBe("15%");
    expect(formatPct(1250, "en")).toBe("12.5%");
  });
});

describe("formatDayKey", () => {
  // Node reads `process.env.TZ` dynamically on every Date/Intl call (not
  // just at process start), so flipping it mid-test genuinely changes the
  // runtime zone `Intl.DateTimeFormat` resolves against here — no fake-timer
  // trick needed. Confirmed for this vitest setup before relying on it.
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("renders a day-key as its own calendar day under a negative-offset runtime zone", () => {
    process.env.TZ = "America/Los_Angeles"; // UTC-7 in July — west of UTC
    expect(formatDayKey("2026-07-15", "en")).toBe("Jul 15, 2026");
  });

  it("demonstrates the bug this fix avoids: naive (non-UTC-pinned) formatting rolls back a day", () => {
    process.env.TZ = "America/Los_Angeles";
    const naive = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "numeric",
    }).format(new Date("2026-07-15"));
    expect(naive).toBe("Jul 14, 2026"); // the day-before bug, absent the UTC pin
    expect(formatDayKey("2026-07-15", "en")).toBe("Jul 15, 2026"); // fixed
  });

  it("stays on the correct calendar day at a UTC-day year boundary, both east and west of UTC", () => {
    process.env.TZ = "Etc/GMT+12"; // UTC-12, the farthest west offset
    expect(formatDayKey("2026-01-01", "en")).toBe("Jan 1, 2026");
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, the farthest east offset
    expect(formatDayKey("2026-01-01", "en")).toBe("Jan 1, 2026");
  });

  it("renders correctly in Arabic too", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatDayKey("2026-07-15", "ar")).toContain("١٥"); // Arabic-Indic 15
  });
});

describe("formatBusinessDate", () => {
  // Same canary pattern as `formatDayKey` above: `TZ` genuinely changes what
  // `Intl.DateTimeFormat` resolves against for every call, so no fake-timer
  // trick is needed to exercise the runtime-zone-independence this proves.
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 03:00 UTC on Jul 30 — `reporting.ts`'s `dayWindow` buckets this order
  // into the Jul 30 UTC day regardless of who's viewing it.
  const orderStampedUtc = new Date("2026-07-30T03:00:00Z");

  it("renders a business-date Date as its own UTC calendar day under a negative-offset runtime zone", () => {
    process.env.TZ = "America/Los_Angeles"; // UTC-7 in July — west of UTC
    expect(formatBusinessDate(orderStampedUtc, "en")).toBe("Jul 30, 2026");
  });

  it("demonstrates the bug this avoids: the viewer's-runtime-zone formatter rolls the date back", () => {
    process.env.TZ = "America/Los_Angeles";
    // 03:00 UTC minus the 7-hour LA offset is 20:00 the PREVIOUS day — this
    // is exactly the gap Fix 2 closes: a sales list using `formatDate` (or
    // any non-pinned formatter) here would show Jul 29 for an order the
    // dashboard KPI already counted under Jul 30.
    const naive = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "numeric",
    }).format(orderStampedUtc);
    expect(naive).toBe("Jul 29, 2026"); // the day-before bug, absent the UTC pin
    expect(formatBusinessDate(orderStampedUtc, "en")).toBe("Jul 30, 2026"); // fixed
  });

  it("stays on the correct calendar day at a UTC-day year boundary, both east and west of UTC", () => {
    const newYearMidnightUtc = new Date("2026-01-01T00:00:00Z");
    process.env.TZ = "Etc/GMT+12"; // UTC-12, the farthest west offset
    expect(formatBusinessDate(newYearMidnightUtc, "en")).toBe("Jan 1, 2026");
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, the farthest east offset
    expect(formatBusinessDate(newYearMidnightUtc, "en")).toBe("Jan 1, 2026");
  });

  it("is independent of the runtime zone — proves the UTC pin, not just one offset", () => {
    process.env.TZ = "America/Los_Angeles";
    const west = formatBusinessDate(orderStampedUtc, "en");
    process.env.TZ = "Pacific/Kiritimati";
    const east = formatBusinessDate(orderStampedUtc, "en");
    expect(west).toBe(east);
    expect(west).toBe("Jul 30, 2026");
  });

  it("renders correctly in Arabic too", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatBusinessDate(orderStampedUtc, "ar")).toContain("٣٠"); // Arabic-Indic 30
  });
});

describe("formatBusinessDateTime", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 03:00 UTC on Jul 30 — same instant `formatBusinessDate`'s tests use.
  const movementStampedUtc = new Date("2026-07-30T03:00:00Z");

  it("includes the UTC hour/minute alongside the UTC calendar day", () => {
    process.env.TZ = "America/Los_Angeles"; // UTC-7 in July — west of UTC
    expect(formatBusinessDateTime(movementStampedUtc, "en")).toBe("Jul 30, 2026, 03:00 AM");
  });

  it("is independent of the runtime zone — proves the UTC pin on both date and time", () => {
    process.env.TZ = "America/Los_Angeles";
    const west = formatBusinessDateTime(movementStampedUtc, "en");
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, the farthest east offset
    const east = formatBusinessDateTime(movementStampedUtc, "en");
    expect(west).toBe(east);
  });

  it("distinguishes two movements that share the same UTC calendar day", () => {
    const morning = new Date("2026-07-30T03:00:00Z");
    const afternoon = new Date("2026-07-30T15:45:00Z");
    // Same day under the date-only formatter...
    expect(formatBusinessDate(morning, "en")).toBe(formatBusinessDate(afternoon, "en"));
    // ...but distinguishable once the time is included.
    expect(formatBusinessDateTime(morning, "en")).not.toBe(formatBusinessDateTime(afternoon, "en"));
  });
});

describe("formatDate", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("renders an instant in the viewer's own runtime zone — the opposite of formatBusinessDate", () => {
    const instant = new Date("2026-07-30T03:00:00Z");
    process.env.TZ = "America/Los_Angeles";
    // Correct reading of "when did this actually happen" in LA is still
    // Jul 29 for this instant — deliberately the mirror image of
    // `formatBusinessDate`'s Jul 30 for the exact same Date, demonstrating
    // why a business-date column must never use this formatter instead.
    expect(formatDate(instant, "en")).toBe("Jul 29, 2026");
    expect(formatBusinessDate(instant, "en")).toBe("Jul 30, 2026");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import { recordAdSpend, adSpendForPeriod } from "@/services/adspend";
import { makeCompany, makeProduct, makeCtx, resetDb } from "../../tests/factories";

const JAN_START = new Date("2026-01-01T00:00:00.000Z");
const JAN_END = new Date("2026-01-31T23:59:59.000Z");

async function setup() {
  const company = await makeCompany();
  const ctx = makeCtx(company.id);
  const alpha = await makeProduct(company.id, "SKU-ALPHA");
  const beta = await makeProduct(company.id, "SKU-BETA");
  return { company, ctx, alpha, beta };
}

describe("recordAdSpend", () => {
  beforeEach(resetDb);

  it("stores the amount against its period and channel", async () => {
    const { ctx } = await setup();

    const { adSpendId } = await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(400),
    });

    const row = await prisma.adSpend.findUniqueOrThrow({ where: { id: adSpendId } });
    expect(row.amount).toBe(toMinor(400));
    expect(row.channel).toBe("META");
    expect(row.productId).toBeNull();
  });

  it("refuses a period whose end precedes its start", async () => {
    const { ctx } = await setup();

    await expect(recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_END, periodEnd: JAN_START,
      amount: toMinor(400),
    })).rejects.toMatchObject({ code: "ADSPEND_INVALID_PERIOD" });

    expect(await prisma.adSpend.count()).toBe(0);
  });

  it("refuses a negative amount", async () => {
    const { ctx } = await setup();

    await expect(recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: -1,
    })).rejects.toMatchObject({ code: "ADSPEND_INVALID_AMOUNT" });

    expect(await prisma.adSpend.count()).toBe(0);
  });

  it("refuses a product belonging to another company", async () => {
    const { ctx } = await setup();
    const other = await makeCompany("Other Co");
    const theirs = await makeProduct(other.id, "THEIRS");

    await expect(recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(100), productId: theirs.id,
    })).rejects.toThrow();

    expect(await prisma.adSpend.count()).toBe(0);
  });
});

describe("adSpendForPeriod straddling the window", () => {
  beforeEach(resetDb);

  // A campaign rarely lines up with a calendar month. The original query
  // required the whole spend period to sit INSIDE the window, so a campaign
  // running across the month boundary vanished from both reports — silently
  // understating cost and overstating profit in every one of them.
  it("counts a campaign that starts before the window and ends inside it", async () => {
    const { ctx } = await setup();
    // 10 days: 5 in December, 5 in January. 1000 total, so 500 belongs to Jan.
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2025-12-27T00:00:00.000Z"),
      periodEnd: new Date("2026-01-05T23:59:59.000Z"),
      amount: toMinor(1000),
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.total).toBe(toMinor(500));
  });

  it("counts a campaign that starts inside the window and ends after it", async () => {
    const { ctx } = await setup();
    // 10 days: 5 in January, 5 in February.
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2026-01-27T00:00:00.000Z"),
      periodEnd: new Date("2026-02-05T23:59:59.000Z"),
      amount: toMinor(1000),
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.total).toBe(toMinor(500));
  });

  it("counts a campaign that spans the whole window", async () => {
    const { ctx } = await setup();
    // A quarter-long campaign seen through a one-month window: January is 31
    // of the 90 days.
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2026-01-01T00:00:00.000Z"),
      periodEnd: new Date("2026-03-31T23:59:59.000Z"),
      amount: toMinor(900),
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThan(toMinor(900));
  });

  it("ignores a campaign that does not overlap the window at all", async () => {
    const { ctx } = await setup();
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2026-03-01T00:00:00.000Z"),
      periodEnd: new Date("2026-03-31T23:59:59.000Z"),
      amount: toMinor(1000),
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.total).toBe(0);
  });

  it("splits a straddling campaign across two windows without inventing money", async () => {
    const { ctx } = await setup();
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2026-01-27T00:00:00.000Z"),
      periodEnd: new Date("2026-02-05T23:59:59.000Z"),
      amount: toMinor(1000),
    });

    const jan = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });
    const feb = await adSpendForPeriod(ctx, {
      from: new Date("2026-02-01T00:00:00.000Z"),
      to: new Date("2026-02-28T23:59:59.000Z"),
    });

    // Counting the full amount in both months would double the cost of the
    // campaign the moment the merchant looked at two reports.
    expect(jan.total + feb.total).toBe(toMinor(1000));
  });

  it("allocates only the overlapping portion to products", async () => {
    const { ctx, alpha } = await setup();
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2026-01-27T00:00:00.000Z"),
      periodEnd: new Date("2026-02-05T23:59:59.000Z"),
      amount: toMinor(1000),
      productId: alpha.id,
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.byProduct.get(alpha.id)).toBe(toMinor(500));
  });
});

describe("adSpendForPeriod", () => {
  beforeEach(resetDb);

  it("attributes directly-tagged spend to its product", async () => {
    const { ctx, alpha } = await setup();
    await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(250), productId: alpha.id,
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.total).toBe(toMinor(250));
    expect(result.byProduct.get(alpha.id)).toBe(toMinor(250));
  });

  it("allocates untagged spend across products by revenue share", async () => {
    // Revenue 300 and 100 against 400 of untagged spend gives 300 and 100 —
    // by revenue, not by unit count, so a cheap high-volume line does not
    // absorb the budget of an expensive one.
    const { ctx, alpha, beta } = await setup();
    await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(400),
    });

    const result = await adSpendForPeriod(ctx, {
      from: JAN_START, to: JAN_END,
      revenueByProduct: new Map([[alpha.id, toMinor(300)], [beta.id, toMinor(100)]]),
    });

    expect(result.byProduct.get(alpha.id)).toBe(toMinor(300));
    expect(result.byProduct.get(beta.id)).toBe(toMinor(100));
    expect(result.total).toBe(toMinor(400));
  });

  it("leaves untagged spend unallocated when there is no revenue to allocate by", async () => {
    // Dividing by zero revenue would either crash or invent an allocation.
    // The total still stands; it simply reaches no product.
    const { ctx } = await setup();
    await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(400),
    });

    const result = await adSpendForPeriod(ctx, {
      from: JAN_START, to: JAN_END, revenueByProduct: new Map(),
    });

    expect(result.total).toBe(toMinor(400));
    expect(result.unallocated).toBe(toMinor(400));
    expect(result.byProduct.size).toBe(0);
  });

  it("never writes an allocation to the database", async () => {
    // THE load-bearing guard for spec 4.2. Storing the allocation means a
    // late-arriving invoice rewrites history.
    const { ctx, alpha, beta } = await setup();
    await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(400),
    });

    await adSpendForPeriod(ctx, {
      from: JAN_START, to: JAN_END,
      revenueByProduct: new Map([[alpha.id, toMinor(300)], [beta.id, toMinor(100)]]),
    });

    const rows = await prisma.adSpend.findMany();
    expect(rows).toHaveLength(1);
    // Still exactly as entered: untagged, one row, no derived children.
    expect(rows[0].productId).toBeNull();
    expect(rows[0].amount).toBe(toMinor(400));
  });

  it("recomputes when a late invoice arrives for a period already read", async () => {
    // This is the behaviour that justifies computing on read. The second read
    // MUST differ — and if the allocation had been stored, it would not.
    const { ctx, alpha } = await setup();
    await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(200), productId: alpha.id,
    });

    const first = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });
    expect(first.byProduct.get(alpha.id)).toBe(toMinor(200));

    await recordAdSpend(ctx, {
      channel: "GOOGLE", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(150), productId: alpha.id,
    });

    const second = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });
    expect(second.byProduct.get(alpha.id)).toBe(toMinor(350));
  });

  it("excludes spend outside the window", async () => {
    const { ctx, alpha } = await setup();
    await recordAdSpend(ctx, {
      channel: "META",
      periodStart: new Date("2025-12-01T00:00:00.000Z"),
      periodEnd: new Date("2025-12-31T00:00:00.000Z"),
      amount: toMinor(999), productId: alpha.id,
    });

    const result = await adSpendForPeriod(ctx, { from: JAN_START, to: JAN_END });

    expect(result.total).toBe(0);
  });

  it("does not read another company's spend", async () => {
    const { ctx, alpha } = await setup();
    await recordAdSpend(ctx, {
      channel: "META", periodStart: JAN_START, periodEnd: JAN_END,
      amount: toMinor(400), productId: alpha.id,
    });

    const other = await makeCompany("Other Co");
    const result = await adSpendForPeriod(makeCtx(other.id), { from: JAN_START, to: JAN_END });

    expect(result.total).toBe(0);
  });
});

/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { getTranslator } from "@/lib/i18n";
import type { SyncRunView } from "@/services/fasthub/syncRun";
import { SyncAlert } from "./SyncAlert";

/**
 * Written AFTER the component, unlike the rest of this codebase — the
 * component shipped in the same commit. Kept and made to discriminate rather
 * than dropped, because this is precisely the check the project's own history
 * says it needs: a feature that runs and reports into a place nobody looks is
 * how a whole subsystem stayed inert for eight tasks here.
 */

afterEach(cleanup);

// The banner now carries the sync button, which is a Client Component holding
// `useRouter`; jsdom has no Next router around it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const noop = async () => {};

const EMPTY_ATTENTION = {
  unknownSkus: [], preOpening: [], failedOrders: [], draftsUnreadable: [], cancelledAfterConfirm: [],
  qcSplitMissing: [], failedResources: [], differences: [],
};

function run(overrides: Partial<SyncRunView> = {}): SyncRunView {
  return {
    id: "r1",
    trigger: "SCHEDULED",
    startedAt: new Date("2026-08-05T10:48:32.000Z"),
    finishedAt: new Date("2026-08-05T10:48:33.000Z"),
    outcome: "ATTENTION",
    ordersCreated: 0,
    claimsOpened: 0,
    diffCount: 0,
    attention: EMPTY_ATTENTION,
    acknowledgedAt: null,
    ...overrides,
  };
}

describe("SyncAlert", () => {
  it("renders nothing when the sync had nothing to report", async () => {
    const t = await getTranslator("en");
    const { container } = render(<SyncAlert runs={[]} locale="en" t={t} acknowledge={noop} />);
    // A daily "all fine" banner trains the owner to stop reading banners.
    expect(container.firstChild).toBeNull();
  });

  it("names the orders it skipped rather than only counting them", async () => {
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[run({
          attention: { ...EMPTY_ATTENTION, preOpening: ["1614465370"], unknownSkus: ["rainy-bundle-001"] },
        })]}
      />,
    );

    // The merchant has to go and look at these in Fast Hub; a bare count tells
    // them nothing about which.
    expect(screen.getByText(/1614465370/)).toBeTruthy();
    expect(screen.getByText(/rainy-bundle-001/)).toBeTruthy();
  });

  /**
   * The banner raising ATTENTION for a stuck draft but rendering no line about
   * it would be the worst of both: a warning with nothing to act on. This
   * project has shipped an inert feature once already.
   */
  it("names a draft it can no longer re-read", async () => {
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[run({ attention: { ...EMPTY_ATTENTION, draftsUnreadable: ["SO-0001"] } })]}
      />,
    );

    expect(screen.getByText(/SO-0001/)).toBeTruthy();
  });

  it("shows a warehouse disagreement with both figures, since one is meaningless alone", async () => {
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[run({
          diffCount: 1,
          attention: {
            ...EMPTY_ATTENTION,
            differences: [{ sku: "flodable-dish-020", fastHub: 11, books: 18 }],
          },
        })]}
      />,
    );

    // Row-scoped, not the whole banner: asserting on the section's textContent
    // would pass even if the two figures landed on different products.
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("flodable-dish-020"));
    expect(row?.textContent).toContain("11");
    expect(row?.textContent).toContain("18");
  });

  it("collapses the same finding repeated across hourly runs into one", async () => {
    // Twelve polls in twelve hours find the same unknown SKU. That is one
    // problem; listing it twelve times buries the others.
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[
          run({ id: "r1", attention: { ...EMPTY_ATTENTION, unknownSkus: ["rainy-bundle-001"] } }),
          run({ id: "r2", attention: { ...EMPTY_ATTENTION, unknownSkus: ["rainy-bundle-001"] } }),
        ]}
      />,
    );

    // Counted inside the rendered TEXT, not by element. The values are joined
    // into one node, so `getAllByText(/rainy-bundle-001/)` returns a single
    // element whether the SKU appears once or twelve times — an assertion that
    // passes either way and proves nothing. Verified by mutation: reverting the
    // dedup leaves that version green and fails this one.
    const listed = screen.getByText(/rainy-bundle-001/).textContent ?? "";
    expect(listed.match(/rainy-bundle-001/g)).toHaveLength(1);
  });

  it("says a resource failed outright, not merely that something needs a look", async () => {
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[run({
          outcome: "FAILED",
          attention: { ...EMPTY_ATTENTION, failedResources: ["returns"] },
        })]}
      />,
    );

    expect(screen.getByText(t("sync.alertFailedTitle"))).toBeTruthy();
    expect(screen.queryByText(t("sync.alertTitle"))).toBeNull();
  });
});

/**
 * Nine SKUs joined by commas into one paragraph, reported as unreadable. Worse,
 * the figures were interpolated raw, so `المستودع 90 / الدفاتر 91` showed
 * Western digits beside money rendered as ٨٬٠٣١٫٩٣ — the same defect the
 * reconcile screen was fixed for, in a component nobody re-checked.
 */
describe("SyncAlert warehouse differences", () => {
  const nine = [
    { sku: "caddy-coaster-015", fastHub: 90, books: 91 },
    { sku: "caddy-oval-014", fastHub: 50, books: 53 },
    { sku: "caddy-long-012", fastHub: 102, books: 2 },
    { sku: "waves-light-004", fastHub: 149, books: 0 },
    { sku: "caddy-corner-011", fastHub: 31, books: 1 },
  ];

  const withDiffs = async (locale: "ar" | "en") =>
    render(
      <SyncAlert
        locale={locale}
        t={await getTranslator(locale)}
        acknowledge={noop}
        runs={[run({ diffCount: nine.length, attention: { ...EMPTY_ATTENTION, differences: nine } })]}
      />,
    );

  it("lays the differences out as a table, not one run-on line", async () => {
    await withDiffs("en");
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    // One row per SKU, plus the header.
    expect(screen.getAllByRole("row").length).toBe(nine.length + 1);
  });

  it("sorts by the difference, so surpluses and shortfalls separate themselves", async () => {
    // The two are different business events: a surplus is stock that arrived
    // and needs a purchase entry, a shortfall is possible loss for the
    // reconciliation. Shuffled together they read as one undifferentiated mess.
    await withDiffs("en");
    // The first CELL of each row, not a regex over the row's whole text — the
    // cells run together, so a loose match reads "waves-light-0041490".
    const skus = screen.getAllByRole("row").slice(1)
      .map((r) => r.querySelector("td")?.textContent);

    expect(skus).toEqual([
      "waves-light-004",   // +149
      "caddy-long-012",    // +100
      "caddy-corner-011",  // +30
      "caddy-coaster-015", // -1
      "caddy-oval-014",    // -3
    ]);
  });

  it("shows the signed difference, not only the two figures", async () => {
    await withDiffs("en");
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("caddy-long-012"));
    expect(row?.textContent).toContain("100");
    const shortfall = screen.getAllByRole("row").find((r) => r.textContent?.includes("caddy-oval-014"));
    expect(shortfall?.textContent).toMatch(/[-−]\s?3/);
  });

  /**
   * Fourteen rows of four columns is what the owner actually gets, and the
   * two figures that decide what to DO with them — how much stock is sitting
   * at the warehouse unrecorded, how much the books cannot account for — were
   * only obtainable by adding up the last column by eye.
   */
  it("summarises surplus and shortfall, so the gist reads without the table", async () => {
    const t = await getTranslator("en");
    await withDiffs("en");
    // +149, +100, +30 = 279 units across three products; -1, -3 = 4 across two.
    expect(screen.getByText(t("sync.alertSurplusSummary", { count: 3, units: "279" }))).toBeTruthy();
    expect(screen.getByText(t("sync.alertShortfallSummary", { count: 2, units: "4" }))).toBeTruthy();
  });

  it("renders the summary figures in Arabic-Indic digits under /ar", async () => {
    await withDiffs("ar");
    // The same defect this component was already fixed for once: a raw number
    // interpolated beside money rendered as ٨٬٠٣١٫٩٣.
    const summary = screen.getByText(/٢٧٩/);
    expect(summary.textContent).not.toContain("279");
  });

  it("renders the figures in Arabic-Indic digits under /ar", async () => {
    await withDiffs("ar");
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("caddy-long-012"));
    expect(row?.textContent).toContain("١٠٢");
    expect(row?.textContent).not.toContain("102");
  });
});

/**
 * The banner used to say "warehouse 90 / books 91" and stop. The reconcile
 * service already knows how to read that gap; this column carries its reading
 * so the owner sees a cause beside every figure, not a figure alone.
 */
describe("SyncAlert explanations", () => {
  const diffs = [
    { sku: "caddy-coaster-015", fastHub: 90, books: 91 },
    { sku: "waves-light-004", fastHub: 149, books: 0 },
    { sku: "ghost-999", fastHub: 4, books: 0 },
  ];

  it("names the cause beside each difference, and admits when there is none", async () => {
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[run({ attention: { ...EMPTY_ATTENTION, differences: diffs } })]}
        explanations={{
          "caddy-coaster-015": { settleable: 0, stillClaimed: 0, unexplained: 1, surplus: 0, determinate: true },
          "waves-light-004": { settleable: 0, stillClaimed: 0, unexplained: 0, surplus: 149, determinate: true },
        }}
      />,
    );

    const rowOf = (sku: string) => screen.getAllByRole("row").find((r) => r.textContent?.includes(sku))!;
    expect(rowOf("caddy-coaster-015").textContent).toContain(`${t("sync.explain.unexplained")} 1`);
    expect(rowOf("waves-light-004").textContent).toContain(`${t("sync.explain.surplus")} 149`);
    // A SKU the books do not know gets a dash, never an invented number.
    expect(rowOf("ghost-999").textContent).toContain("—");
  });

  it("says when the warehouse must split sellable from damaged before anything can be read", async () => {
    const t = await getTranslator("en");
    render(
      <SyncAlert
        locale="en"
        t={t}
        acknowledge={noop}
        runs={[run({ attention: { ...EMPTY_ATTENTION, differences: [diffs[0]] } })]}
        explanations={{
          "caddy-coaster-015": { settleable: 0, stillClaimed: 0, unexplained: 0, surplus: 0, determinate: false },
        }}
      />,
    );
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("caddy-coaster-015"))!;
    expect(row.textContent).toContain(t("sync.explain.indeterminate"));
  });
});

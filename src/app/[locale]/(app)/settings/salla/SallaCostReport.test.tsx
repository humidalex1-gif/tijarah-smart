/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SallaCostReport, type SallaCostReportLabels } from "./SallaCostReport";
import type { CostComparison } from "@/services/salla/costCompare";

/**
 * The screen that finally answers "does Salla hold the three missing costs?"
 *
 * It must never look like it answered when it did not: an empty result and a
 * failed read are different facts, and the difference decides whether the
 * owner goes hunting for the numbers elsewhere.
 */

const readSallaCostsAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ readSallaCostsAction }));

afterEach(cleanup);
beforeEach(() => { readSallaCostsAction.mockReset(); });

const LABELS: SallaCostReportLabels = {
  title: "Costs in Salla", intro: "Read the cost price Salla holds.",
  read: "Read from Salla", reading: "Reading",
  sku: "SKU", ourCost: "Our cost", theirCost: "Salla cost", state: "State",
  repairableTitle: "Costs Salla can supply", commandHint: "Run this to apply them:",
  noneTitle: "Salla holds no cost we can use",
  summaryTemplate: "{salla} products in Salla, {matched} matched, {repairable} repairable",
  status: {
    REPAIRABLE: "Can be repaired", ALREADY_COSTED: "Already costed",
    SALLA_HAS_NO_COST: "No cost in Salla", UNSOLD_COST_AVAILABLE: "Not sold yet",
    NOT_IN_SALLA: "Not in Salla", AMBIGUOUS_IN_SALLA: "Duplicated in Salla",
  },
  errors: { "errors.generic": "Something went wrong", "errors.SALLA_NOT_CONNECTED": "Salla is not connected." },
};

const row = (over: Partial<CostComparison["rows"][number]> = {}): CostComparison["rows"][number] => ({
  sku: "bowl-large-016", nameAr: "وعاء كبير", sallaName: "وعاء كبير",
  ourAvgCost: 0, sallaCostMinor: 1230, sallaCostSar: "12.30",
  status: "REPAIRABLE", ...over,
});

const report = (over: Partial<CostComparison> = {}): CostComparison => {
  const rows = over.rows ?? [row()];
  return {
    rows,
    repairable: over.repairable ?? rows.filter((r) => r.status === "REPAIRABLE"),
    unmatchedSalla: over.unmatchedSalla ?? [],
    summary: over.summary ?? { ourProducts: rows.length, sallaProducts: 1, matched: 1, sallaCostsPresent: 1, repairable: 1 },
  };
};

describe("SallaCostReport", () => {
  it("reads nothing until asked", () => {
    render(<SallaCostReport locale="en" currency="SAR" labels={LABELS} />);

    // The read spends a Salla API call and needs a live authorisation. It is a
    // BUTTON, never something that fires on page load.
    expect(readSallaCostsAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Read from Salla" })).not.toBeNull();
  });

  it("names the products a Salla cost would repair, and the cost", async () => {
    readSallaCostsAction.mockResolvedValue({ ok: true, data: report() });
    render(<SallaCostReport locale="en" currency="SAR" labels={LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Read from Salla" }));

    expect(await screen.findByText("bowl-large-016")).not.toBeNull();
    expect(screen.getByText("Can be repaired")).not.toBeNull();
  });

  it("offers the exact command that applies them, with the figures filled in", async () => {
    readSallaCostsAction.mockResolvedValue({
      ok: true,
      data: report({ rows: [row(), row({ sku: "Pets-large-005", sallaCostSar: "85.45" })] }),
    });
    render(<SallaCostReport locale="en" currency="SAR" labels={LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Read from Salla" }));

    // The repair script has no undo and takes SAR on the command line. Reading
    // the figures off a table by hand is where a digit gets dropped.
    const command = (await screen.findByTestId("salla-cost-command")).textContent ?? "";
    expect(command).toContain("scripts/fix-product-costs.ts");
    expect(command).toContain("bowl-large-016=12.30");
    expect(command).toContain("Pets-large-005=85.45");
    // Dry run by default: --apply is the owner's deliberate second step.
    expect(command).not.toContain("--apply");
  });

  it("says plainly when Salla holds nothing usable, instead of showing an empty table", async () => {
    readSallaCostsAction.mockResolvedValue({
      ok: true,
      data: report({
        rows: [row({ status: "SALLA_HAS_NO_COST", sallaCostMinor: null, sallaCostSar: null })],
        repairable: [],
        summary: { ourProducts: 1, sallaProducts: 1, matched: 1, sallaCostsPresent: 0, repairable: 0 },
      }),
    });
    render(<SallaCostReport locale="en" currency="SAR" labels={LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Read from Salla" }));

    expect(await screen.findByText("Salla holds no cost we can use")).not.toBeNull();
    expect(screen.queryByTestId("salla-cost-command")).toBeNull();
  });

  it("shows a failed read as a failure, never as an empty result", async () => {
    readSallaCostsAction.mockResolvedValue({ ok: false, error: "errors.SALLA_NOT_CONNECTED", code: "SALLA_NOT_CONNECTED" });
    render(<SallaCostReport locale="en" currency="SAR" labels={LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Read from Salla" }));

    expect(await screen.findByText("Salla is not connected.")).not.toBeNull();
    // "Salla holds nothing" would send the owner hunting for numbers that are
    // in fact sitting behind a broken connection.
    expect(screen.queryByText("Salla holds no cost we can use")).toBeNull();
  });
});

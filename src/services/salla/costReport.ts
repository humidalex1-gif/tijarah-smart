import { loadOurCosts } from "./ourCosts";
import { listSallaProducts } from "./api";
import { compareCosts, type CostComparison } from "./costCompare";

/**
 * The whole read, in one call: our costs, Salla's costs, and the difference.
 *
 * Deliberately thin. The two sides are loaded by modules that can each be
 * tested without the other, and the judgement lives in `compareCosts`, which
 * needs neither a network nor a database. This exists so a screen has one
 * thing to call.
 *
 * It answers a question that has been open since 2026-08-06: does Salla hold
 * a cost for `Pets-large-005`, `bowl-large-016` and `bowl-small-017`, whose
 * zero cost puts 45.4% of revenue on the books at 100% margin? It does not
 * ACT on the answer — `scripts/fix-product-costs.ts` does that, run by a
 * human, because there is no undo.
 */
export async function buildSallaCostReport(companyId: string): Promise<CostComparison> {
  // Sequential, not concurrent: the Salla call can fail on auth, and there is
  // no point querying our own books to accompany an error.
  const salla = await listSallaProducts(companyId);
  const ours = await loadOurCosts(companyId);
  return compareCosts(ours, salla);
}

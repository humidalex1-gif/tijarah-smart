import { fromMinor } from "@/lib/money";

/**
 * Comparing our costs against Salla's, and nothing else.
 *
 * Pure on purpose: no HTTP, no Prisma. The question it answers — "does Salla
 * hold a cost for the products we booked at zero?" — has been open for two
 * weeks, and the figures it produces are typed into `fix-product-costs.ts`,
 * which has no undo. So it is the piece that must be provably right, and it is
 * kept where it can be tested without a network or a database.
 *
 * It never WRITES a cost. It reports what a repair would use.
 */

/** Unit costs are minor units x10 000 (rule 5); `avgCost` is on that scale. */
export interface OurProduct {
  sku: string;
  nameAr: string;
  nameEn: string;
  avgCost: number;
  /** Sold at least once. Only a sold product's zero cost distorts profit. */
  sold: boolean;
}

/** `costMinor` is minor units, or null when Salla carries no cost field value. */
export interface SallaProduct {
  sku: string;
  name: string;
  costMinor: number | null;
}

export type CostStatus =
  | "REPAIRABLE"
  | "ALREADY_COSTED"
  | "SALLA_HAS_NO_COST"
  | "UNSOLD_COST_AVAILABLE"
  | "NOT_IN_SALLA"
  | "AMBIGUOUS_IN_SALLA";

export interface CostRow {
  sku: string;
  nameAr: string;
  sallaName: string | null;
  ourAvgCost: number;
  sallaCostMinor: number | null;
  /** The figure as it would be typed into `fix-product-costs.ts`, which takes SAR. */
  sallaCostSar: string | null;
  status: CostStatus;
}

export interface CostComparison {
  rows: CostRow[];
  /** Sold, costed at zero here, and priced in Salla. The actionable set. */
  repairable: CostRow[];
  /** Salla SKUs with no product of ours — usually bundles, which Salla alone holds. */
  unmatchedSalla: string[];
  summary: {
    ourProducts: number;
    sallaProducts: number;
    matched: number;
    sallaCostsPresent: number;
    repairable: number;
  };
}

/**
 * Salla's SKU is typed by a human into a web form; ours arrived from Fast Hub's
 * API. Comparing them raw would miss a match over a capital letter or a
 * trailing space, and a missed match reads as "Salla has no cost" — the exact
 * wrong answer, silently.
 */
const key = (sku: string) => sku.trim().toLowerCase();

export function compareCosts(
  ourProducts: OurProduct[],
  sallaProducts: SallaProduct[],
): CostComparison {
  const bySku = new Map<string, SallaProduct[]>();
  for (const p of sallaProducts) {
    const k = key(p.sku);
    const list = bySku.get(k);
    if (list) list.push(p);
    else bySku.set(k, [p]);
  }

  const matchedKeys = new Set<string>();

  const rows: CostRow[] = ourProducts.map((ours) => {
    const k = key(ours.sku);
    const candidates = bySku.get(k) ?? [];
    if (candidates.length > 0) matchedKeys.add(k);

    const base = {
      sku: ours.sku,
      nameAr: ours.nameAr,
      ourAvgCost: ours.avgCost,
    };

    if (candidates.length > 1) {
      // Two rows cannot both be the cost, and picking by array order would be
      // arbitrary and invisible. Better to name it and let a human look.
      return {
        ...base,
        sallaName: candidates[0]!.name,
        sallaCostMinor: null,
        sallaCostSar: null,
        status: "AMBIGUOUS_IN_SALLA" as const,
      };
    }

    const theirs = candidates[0];
    if (!theirs) {
      return { ...base, sallaName: null, sallaCostMinor: null, sallaCostSar: null, status: "NOT_IN_SALLA" as const };
    }

    // A cost of exactly 0 and an unfilled field mean the same thing here, and
    // writing 0 as a cost is the defect this whole exercise exists to repair.
    const cost = theirs.costMinor !== null && theirs.costMinor > 0 ? theirs.costMinor : null;
    const priced = {
      ...base,
      sallaName: theirs.name,
      sallaCostMinor: cost,
      sallaCostSar: cost === null ? null : fromMinor(cost).toFixed(2),
    };

    // `newAverageCost` moves avgCost only through IN movements, so a product
    // already carrying one holds a real weighted average that a catalogue
    // figure must not overwrite.
    if (ours.avgCost > 0) return { ...priced, status: "ALREADY_COSTED" as const };
    if (cost === null) return { ...priced, status: "SALLA_HAS_NO_COST" as const };
    // An unsold zero-cost product understates inventory value only; no booked
    // profit depends on it, so it is reported but never bundled into a repair.
    if (!ours.sold) return { ...priced, status: "UNSOLD_COST_AVAILABLE" as const };
    return { ...priced, status: "REPAIRABLE" as const };
  });

  return {
    rows,
    repairable: rows.filter((r) => r.status === "REPAIRABLE"),
    unmatchedSalla: sallaProducts.filter((p) => !matchedKeys.has(key(p.sku))).map((p) => p.sku),
    summary: {
      ourProducts: ourProducts.length,
      sallaProducts: sallaProducts.length,
      matched: matchedKeys.size,
      sallaCostsPresent: sallaProducts.filter((p) => p.costMinor !== null && p.costMinor > 0).length,
      repairable: rows.filter((r) => r.status === "REPAIRABLE").length,
    },
  };
}

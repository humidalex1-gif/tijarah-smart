import { toMinor } from "@/lib/money";
import { sallaPaginate } from "./client";
import type { SallaProduct } from "./costCompare";

/**
 * Typed access to the Salla endpoints this app reads.
 *
 * Every fact here was read at docs.salla.dev/5394168e0 on 2026-08-19 rather
 * than recalled: `GET /admin/v2/products`, scope `products.read`, response
 * `{ status, success, data, pagination: { count, current, next } }`, and
 * `cost_price` as a TOP-LEVEL `{ amount, currency }` object — not a field on
 * variants, which is where an earlier guess had put it.
 *
 * READ ONLY. Nothing in this module writes to Salla, and nothing it returns
 * writes to our books; `costCompare` decides what a repair would use and a
 * human runs the repair.
 */

/** Salla's product status vocabulary, verbatim from the List Products docs. */
export type SallaProductStatus = "sale" | "out" | "hidden" | "deleted";

export interface SallaProductPayload {
  id: number;
  sku?: string;
  name?: string;
  status?: SallaProductStatus;
  price?: { amount?: number | string; currency?: string };
  cost_price?: { amount?: number | string; currency?: string };
}

/**
 * Salla sends the amount as a number on the product response and as a string
 * ("35.00") in the bulk-price docs. Both are accepted; anything that is not a
 * finite number becomes null, because a NaN cost would flow into a comparison
 * that decides real money.
 */
function amountToMinor(amount: number | string | undefined): number | null {
  if (amount === undefined || amount === null || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  return toMinor(n);
}

export async function listSallaProducts(companyId: string): Promise<SallaProduct[]> {
  const products: SallaProduct[] = [];

  await sallaPaginate<SallaProductPayload>(
    companyId,
    "/products",
    { perPage: 50 },
    async (page) => {
      for (const row of page) {
        // A deleted product's cost must never be offered as a repair.
        if (row.status === "deleted") continue;
        // Bundles in Salla routinely carry no SKU. An empty key would match
        // every one of our SKU-less products at once and mis-cost them.
        const sku = (row.sku ?? "").trim();
        if (sku === "") continue;

        products.push({
          sku,
          name: row.name ?? "",
          costMinor: amountToMinor(row.cost_price?.amount),
        });
      }
    },
  );

  return products;
}

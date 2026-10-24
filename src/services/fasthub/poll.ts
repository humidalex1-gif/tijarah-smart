import { prisma } from "@/lib/db";
import { toQty } from "@/lib/money";
import { fetchHubInventory } from "@/services/fasthub/api";
import { syncFastHubOrders, type OrderSyncReport } from "@/services/fasthub/orders";
import { syncFastHubReturns, type ReturnSyncReport } from "@/services/fasthub/returns";
import { recordSyncRun } from "@/services/fasthub/syncRun";

/**
 * The catch-up poll: everything the app asks Fast Hub when the merchant opens
 * it. Each resource carries its own cursor, so one failing endpoint cannot
 * stall the others — a broken returns feed must not silently stop orders from
 * arriving.
 */

export type InventoryLine = {
  productId: string;
  sku: string;
  /** What Fast Hub says is sellable, in thousandths. */
  sellable: number;
  /** What Fast Hub says is on hand including reserved, in thousandths. */
  onHand: number;
  /** What our books say is available, in thousandths. */
  booksAvailable: number;
  /** sellable - booksAvailable. Negative means the warehouse holds fewer. */
  difference: number;
};

export type InventorySyncReport = {
  lines: InventoryLine[];
  unknownSkus: string[];
};

/**
 * Reads the warehouse's own counts and compares them to the books.
 *
 * This deliberately WRITES NOTHING. Mirroring Fast Hub's numbers into our
 * balances would erase the discrepancy this whole project exists to expose —
 * the difference IS the product. The output feeds the reconcile screen, where
 * the merchant decides what to post.
 */
export async function syncFastHubInventory(
  companyId: string,
  warehouseId: string,
  hubCode: string,
  window?: { updatedFrom: string; updatedTo: string },
): Promise<InventorySyncReport> {
  const rows = await fetchHubInventory(companyId, hubCode, window);
  const report: InventorySyncReport = { lines: [], unknownSkus: [] };
  if (rows.length === 0) return report;

  const products = await prisma.product.findMany({
    where: { companyId, sku: { in: [...new Set(rows.map((r) => r.sku_code))] } },
    select: { id: true, sku: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p.id]));

  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId, warehouseId, productId: { in: [...bySku.values()] } },
    select: { productId: true, availableQty: true },
  });
  const availableBy = new Map(balances.map((b) => [b.productId, b.availableQty]));

  for (const row of rows) {
    const productId = bySku.get(row.sku_code);
    if (!productId) {
      if (!report.unknownSkus.includes(row.sku_code)) report.unknownSkus.push(row.sku_code);
      continue;
    }
    const sellable = toQty(row.available_quantity);
    const booksAvailable = availableBy.get(productId) ?? 0;
    report.lines.push({
      productId,
      sku: row.sku_code,
      sellable,
      onHand: toQty(row.quantity_on_hand),
      booksAvailable,
      difference: sellable - booksAvailable,
    });
  }

  return report;
}

export type PollReport = {
  orders: OrderSyncReport | null;
  returns: ReturnSyncReport | null;
  inventory: InventorySyncReport | null;
  /** Resources that threw, with the message. The others still ran. */
  failures: { resource: "orders" | "returns" | "inventory"; message: string }[];
  polledAt: Date;
};

export async function pollFastHub(
  companyId: string,
  warehouseId: string,
  hubCode: string,
  /**
   * Who asked. Recorded so a failure can be read correctly: a MANUAL run that
   * fails is being watched by someone, a SCHEDULED one that fails is not.
   */
  trigger: "SCHEDULED" | "MANUAL" = "MANUAL",
): Promise<PollReport> {
  // Fail fast and loudly when there is nothing to poll with, rather than
  // returning three empty reports that look like a quiet, healthy sync.
  await prisma.fastHubConnection.findUniqueOrThrow({ where: { companyId } });

  const startedAt = new Date();
  const report: PollReport = {
    orders: null, returns: null, inventory: null, failures: [], polledAt: new Date(),
  };

  const run = async <T>(
    resource: "orders" | "returns" | "inventory",
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      // Recorded, never swallowed: a silent failure here is indistinguishable
      // from "nothing happened at Fast Hub today", and the merchant would
      // trust an empty screen.
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ resource, message });
      console.error(`Fast Hub ${resource} sync failed:`, error);
      return null;
    }
  };

  report.orders = await run("orders", () => syncFastHubOrders(companyId, warehouseId));
  report.returns = await run("returns", () => syncFastHubReturns(companyId, warehouseId));
  report.inventory = await run("inventory", () => syncFastHubInventory(companyId, warehouseId, hubCode));
  report.polledAt = new Date();

  // Recorded here rather than in each caller, so the hourly timer and the
  // button on the settings screen cannot drift into reporting differently.
  try {
    await recordSyncRun(companyId, report, { trigger, startedAt });
  } catch (error) {
    // The poll itself succeeded; failing to write the history row must not
    // discard its work or make the caller think the sync failed. Logged, not
    // swallowed silently.
    console.error("Could not record the sync run:", error);
  }

  return report;
}

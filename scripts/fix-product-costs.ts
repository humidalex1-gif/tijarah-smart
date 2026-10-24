import { prisma } from "@/lib/db";
import { toCost, toMinor } from "@/lib/money";
import {
  planCostCorrection,
  applyCostCorrection,
  type CostInput,
} from "@/services/costCorrection";

/**
 * Puts a real cost on products opened at zero, and on the orders that sold them.
 * See `src/services/costCorrection.ts` and the spec at
 * `docs/superpowers/specs/2026-08-06-cost-correction-design.md`.
 *
 * Costs are given as SAR per unit on the command line, `sku=cost`:
 *
 *   node --env-file=.env --import tsx scripts/fix-product-costs.ts \
 *     Pets-large-005=85.45 bowl-large-016=12.30 bowl-small-017=9.80
 *
 * That prints what it would write and touches nothing. Add `--apply` to commit.
 *
 * BACK UP `data/app.db` FIRST — `cp data/app.db data/app.db.before-cost-fix`.
 * There is no undo. Safe to run twice: a product already carrying a cost is
 * skipped, and the order restatement recomputes rather than accumulates.
 *
 * The figures must be the LANDED cost per unit — purchase plus the freight and
 * clearance the owner's costing sheet allocates by weight. Advertising must
 * never be in here (rule 7): it is a period cost and `avgCost` has no rebuild
 * path once it is polluted.
 */

const APPLY = process.argv.includes("--apply");

/** Quantities are thousandths; unit costs are minor units x10 000. */
const units = (scaled: number) => (scaled / 1000).toString();
const money = (minor: number) => (minor / 100).toFixed(2);
const costMoney = (cost: number) => (cost / 10000 / 100).toFixed(2);

function parseCosts(): CostInput[] {
  const costs: CostInput[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") continue;
    const at = arg.lastIndexOf("=");
    // lastIndexOf, not split: a SKU may legitimately contain '='. Splitting
    // would take the first half as the SKU and silently correct nothing.
    if (at <= 0) {
      throw new Error(`Expected sku=cost, got "${arg}"`);
    }
    const sku = arg.slice(0, at);
    const value = Number(arg.slice(at + 1));
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`"${sku}" has a cost of "${arg.slice(at + 1)}", which is not a positive number`);
    }
    costs.push({ sku, unitCost: toCost(toMinor(value)) });
  }
  return costs;
}

async function run() {
  const costs = parseCosts();
  if (costs.length === 0) {
    console.log("\n  Usage: fix-product-costs.ts sku=cost [sku=cost ...] [--apply]\n");
    await prisma.$disconnect();
    return;
  }

  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true, companyId: true, name: true },
  });
  const ctx = { companyId: warehouse.companyId, userId: null };

  const plan = await planCostCorrection(ctx, { warehouseId: warehouse.id, costs });

  console.log(`\n  Warehouse: ${warehouse.name}\n`);

  // Unknowns first. A typo that silently corrects nothing is the failure this
  // whole script exists to avoid.
  if (plan.unknownSkus.length > 0) {
    console.log(`  !! NO SUCH SKU: ${plan.unknownSkus.join(", ")}`);
    console.log("     Check the spelling against the Fast Hub SKU — they are case-sensitive (Pets-large-005).\n");
  }
  if (plan.skipped.length > 0) {
    console.log(`  -- already costed, left alone: ${plan.skipped.map((s) => s.sku).join(", ")}\n`);
  }

  if (plan.lines.length === 0) {
    console.log("  Nothing to correct.\n");
    await prisma.$disconnect();
    return;
  }

  console.log("  SKU                   revalued    unit cost      stock value");
  console.log("  " + "-".repeat(58));
  for (const line of plan.lines) {
    const value = (line.revaluedQty / 1000) * line.unitCost;
    console.log(
      "  " + line.sku.padEnd(22) +
      units(line.revaluedQty).padStart(8) +
      costMoney(line.unitCost).padStart(13) +
      costMoney(value).padStart(17),
    );
  }

  const restated = plan.lines.flatMap((l) => l.restatedOrders);
  if (restated.length > 0) {
    console.log("\n  Orders whose cost and profit change:\n");
    console.log("  order       units    cost added");
    console.log("  " + "-".repeat(34));
    for (const line of plan.lines) {
      for (const order of line.restatedOrders) {
        console.log(
          "  " + order.salesOrderNumber.padEnd(12) +
          units(order.quantity).padStart(5) +
          money(order.addedCost).padStart(14),
        );
      }
    }
    console.log("  " + "-".repeat(34));
    console.log(`  ${restated.length} lines, ${money(plan.totalCostAdded)} SAR of cost added`);
    console.log("  Gross profit falls by exactly that, and net profit follows.\n");
  } else {
    console.log("\n  No confirmed order sold these at zero cost.\n");
  }

  if (!APPLY) {
    console.log("  DRY RUN — nothing written. Re-run with --apply to commit.\n");
    await prisma.$disconnect();
    return;
  }

  const done = await applyCostCorrection(ctx, { warehouseId: warehouse.id, costs });
  console.log(
    `  APPLIED — ${done.lines.length} products revalued, `
    + `${done.lines.flatMap((l) => l.restatedOrders).length} order lines restated, `
    + `${money(done.totalCostAdded)} SAR of cost booked.\n`,
  );
  await prisma.$disconnect();
}

run().catch(async (error) => {
  console.error(error instanceof Error ? `\n  ${error.message}\n` : error);
  await prisma.$disconnect();
  process.exit(1);
});

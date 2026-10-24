import { prisma } from "@/lib/db";
import {
  planOpeningCorrection,
  applyOpeningCorrection,
} from "@/services/fasthub/opening-correction";

/**
 * Repairs the double deduction described in
 * `src/services/fasthub/opening-correction.ts`.
 *
 * Usage on the server, dry run first — it prints exactly what it would write
 * and touches nothing:
 *   node --env-file=.env --import tsx scripts/fix-opening-balance.ts
 * Then, once the table reads right:
 *   node --env-file=.env --import tsx scripts/fix-opening-balance.ts --apply
 *
 * BACK UP `data/app.db` FIRST. There is no undo, and no nightly backup exists
 * yet. Safe to run twice: the correction is dated before the orders it
 * accounts for, so a second run computes nothing to do.
 */

const APPLY = process.argv.includes("--apply");

/** Quantities are thousandths; unit costs are minor units x10 000. */
const units = (scaled: number) => (scaled / 1000).toString();
const money = (cost: number) => (cost / 10000 / 100).toFixed(2);

async function run() {
  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true, companyId: true, name: true },
  });
  const ctx = { companyId: warehouse.companyId, userId: null };

  const plan = await planOpeningCorrection(ctx, { warehouseId: warehouse.id });
  if (plan.lines.length === 0) {
    console.log(`\n  Nothing to correct at ${warehouse.name}. The books and the opening balance agree.\n`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\n  Warehouse: ${warehouse.name}`);
  console.log(`  Opening balance re-dated to: ${plan.lines[0].asOf.toISOString().slice(0, 10)}\n`);
  console.log("  SKU                   units    unit cost    value");
  console.log("  " + "-".repeat(52));
  let value = 0;
  for (const line of plan.lines) {
    value += (line.quantity / 1000) * line.unitCost;
    console.log(
      "  " + line.sku.padEnd(22) +
      units(line.quantity).padStart(5) +
      money(line.unitCost).padStart(13) +
      money((line.quantity / 1000) * line.unitCost).padStart(9),
    );
  }
  console.log("  " + "-".repeat(52));
  console.log(`  ${plan.lines.length} products, ${units(plan.totalQuantity)} units, ${money(value)} SAR\n`);

  if (!APPLY) {
    console.log("  DRY RUN — nothing written. Re-run with --apply to commit.\n");
    await prisma.$disconnect();
    return;
  }

  const result = await applyOpeningCorrection(ctx, { warehouseId: warehouse.id });
  console.log(`  Applied: ${result.lines.length} products, ${units(result.totalQuantity)} units added back.\n`);

  // Print the balances the correction produced. The point of the exercise is
  // that these now match the Fast Hub dashboard, so they belong on screen
  // where they can be compared line by line rather than trusted.
  const balances = await prisma.inventoryBalance.findMany({
    where: { companyId: ctx.companyId, warehouseId: warehouse.id },
    select: { availableQty: true, damagedQty: true, product: { select: { sku: true } } },
  });
  balances.sort((a, b) => a.product.sku.localeCompare(b.product.sku));
  console.log("  SKU                   available   damaged");
  console.log("  " + "-".repeat(45));
  for (const balance of balances) {
    console.log(
      "  " + balance.product.sku.padEnd(22) +
      units(balance.availableQty).padStart(9) +
      units(balance.damagedQty).padStart(10),
    );
  }
  console.log("");

  await prisma.$disconnect();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

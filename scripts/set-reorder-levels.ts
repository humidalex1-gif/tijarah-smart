import { prisma } from "@/lib/db";
import { toQty } from "@/lib/money";

/**
 * Sets a uniform reorder level, because zero means the low-stock alert can
 * never fire and the merchant finds out they are out of something from a
 * customer.
 *
 * The owner chose a flat 10 units on 2026-08-05 over a figure computed from
 * sales history: 15 orders across three months puts most products at one or
 * two units of 30-day cover, which is far too late a warning for goods that
 * arrive from China. It is a starting line, not a model — every product's
 * level is editable on its own screen.
 *
 * Only stock-tracked, non-bundle products. A bundle owns no shelf; alerting on
 * one would be alerting on a number that does not exist.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/set-reorder-levels.ts          # dry run
 *   node --env-file=.env --import tsx scripts/set-reorder-levels.ts --apply
 *   ... --apply --level 25
 */

const APPLY = process.argv.includes("--apply");
const levelArg = process.argv.indexOf("--level");
const LEVEL_UNITS = levelArg > -1 ? Number(process.argv[levelArg + 1]) : 10;

async function run() {
  if (!Number.isFinite(LEVEL_UNITS) || LEVEL_UNITS < 0) {
    throw new Error(`--level must be a non-negative number, got ${process.argv[levelArg + 1]}`);
  }
  const level = toQty(LEVEL_UNITS);

  // Products already carrying a level are left alone: this is a floor for
  // products nobody has thought about, not a bulldozer over decisions already
  // made on the product screen.
  const targets = await prisma.product.findMany({
    where: { isBundle: false, trackInventory: true, reorderLevel: 0, status: "ACTIVE" },
    select: { id: true, sku: true },
    orderBy: { sku: "asc" },
  });

  if (targets.length === 0) {
    console.log("\n  Every active product already carries a reorder level.\n");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n  Setting reorder level to ${LEVEL_UNITS} units on ${targets.length} products:\n`);
  for (const product of targets) console.log(`    ${product.sku}`);

  if (!APPLY) {
    console.log("\n  DRY RUN — nothing written. Re-run with --apply to commit.\n");
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.product.updateMany({
    where: { id: { in: targets.map((p) => p.id) } },
    data: { reorderLevel: level },
  });
  console.log(`\n  Updated ${result.count} products.`);

  // Show what will alert now, so the change is judged by its effect rather
  // than by the fact that it ran.
  const balances = await prisma.inventoryBalance.findMany({
    where: { productId: { in: targets.map((p) => p.id) } },
    select: { availableQty: true, product: { select: { sku: true } } },
  });
  const low = balances
    .filter((b) => b.availableQty < level)
    .sort((a, b) => a.availableQty - b.availableQty);
  console.log(`  Below the line right now: ${low.length}`);
  for (const b of low) console.log(`    ${b.product.sku.padEnd(22)} ${b.availableQty / 1000}`);
  console.log("");

  await prisma.$disconnect();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { prisma } from "@/lib/db";
import { toMinor } from "@/lib/money";
import { registerCompany, completeOnboarding } from "@/services/accounts";

const DEMO_EMAIL = "owner@tijarah.test";
const DEMO_PASSWORD = "demo12345";

/**
 * The real SokuDry catalogue, captured 2026-08-04 from the Fast Hub dashboard
 * (fasthub.dashboard.omniful.com, seller `Sokudry`) and the live sokudry.com
 * storefront. Sources and open questions live in docs/HANDOFF.md.
 *
 * Rules this seed follows deliberately:
 * - The Fast Hub SKU is canonical (its Arabic names match Salla's exactly).
 *   A `PENDING-` sku marks a product seen in the store whose Fast Hub SKU has
 *   not been captured yet — replace it with the real SKU, never treat it as
 *   one. The inventory sync matches on SKU, so PENDING rows will not sync
 *   until corrected, which is the honest failure mode.
 * - Costs come from the owner's costing spreadsheet (received 2026-08-04):
 *   `cost` below is the BARE supplier unit price in SAR. The landed cost per
 *   unit (purchase + shipping + per-kg overhead) feeds `avgCost` through the
 *   opening-stock import, not through this seed. Products absent from the
 *   sheet (very-large, bowls, coaster, the two pet-stand sizes) keep 0 until
 *   the owner clarifies — 0 is a visible gap, a guess would be an invisible one.
 * - No quantities are seeded. Stock levels move daily at Fast Hub; the
 *   inventory sync is the source of truth, so every balance starts empty.
 * - Prices are current sale prices in SAR as seen on the storefront.
 */
const PRODUCTS: {
  sku: string;
  nameAr: string;
  nameEn: string;
  price: number;
  category: "bath" | "kitchen" | "pets";
  /** Bare supplier unit price in SAR, from the owner's costing sheet. */
  cost?: number;
  /** No longer sold — kept for history so synced old orders still resolve. */
  archived?: boolean;
}[] = [
  // Bath — mats. The 260 SAR family comes in قطرات/أمواج × فاتح/غامق.
  { sku: "very-large", nameAr: "الدعاسة الأحفورية - مقاس كبير", nameEn: "Diatomite Bath Mat - Large", price: 199, category: "bath" },
  { sku: "waves-light-004", nameAr: "الدعاسة الأحفورية - أمواج (فاتح)", nameEn: "Diatomite Bath Mat - Waves (Light)", price: 260, category: "bath", cost: 15 },
  // The قطرات mats are "rainy" in Fast Hub, not "drops" — captured from the
  // live inventory API on 2026-08-04, not guessed.
  { sku: "waves-dark-003", nameAr: "الدعاسة الأحفورية - أمواج (غامق)", nameEn: "Diatomite Bath Mat - Waves (Dark)", price: 260, category: "bath", cost: 15 },
  { sku: "rainy-light-002", nameAr: "الدعاسة الأحفورية - قطرات (فاتح)", nameEn: "Diatomite Bath Mat - Drops (Light)", price: 260, category: "bath", cost: 15 },
  { sku: "rainy-dark-001", nameAr: "الدعاسة الأحفورية - قطرات (غامق)", nameEn: "Diatomite Bath Mat - Drops (Dark)", price: 260, category: "bath", cost: 15 },
  // Discontinued (owner, 2026-08-04): archived, not deleted, so an old synced
  // order can still resolve its SKU. Prices from the costing sheet.
  { sku: "marble-white-007", nameAr: "الدعاسة الرخامية الفاخرة", nameEn: "Luxury Marble Bath Mat", price: 253, category: "bath", cost: 13.13, archived: true },
  { sku: "dishrack-white-008", nameAr: "المجفف الذكي - أبيض", nameEn: "Smart Dish Rack - White", price: 298, category: "kitchen", cost: 35.6, archived: true },
  { sku: "dishrack-black-009", nameAr: "المجفف الذكي - أسود", nameEn: "Smart Dish Rack - Black", price: 298, category: "kitchen", cost: 35.6, archived: true },
  { sku: "guest-white-010", nameAr: "صينية الضيافة", nameEn: "Serving Tray", price: 126, category: "kitchen", cost: 16.9, archived: true },
  // Bath — toothbrush holders.
  { sku: "holder-light-019", nameAr: "حامل فرشاة الاسنان الاحفوري - فاتح/أبيض", nameEn: "Diatomite Toothbrush Holder - Light/White", price: 89, category: "bath", cost: 5.3 },
  { sku: "holder-dark-018", nameAr: "حامل فرشاة الاسنان الاحفوري - غامق/رمادي", nameEn: "Diatomite Toothbrush Holder - Dark/Grey", price: 89, category: "bath", cost: 5.3 },
  // Caddies. Category assignment is provisional (bath, as shower caddies)
  // until the Salla product sync brings the store's own category mapping.
  { sku: "caddy-corner-011", nameAr: "الوعاء الأحفوري - ركن", nameEn: "Diatomite Caddy - Corner", price: 71, category: "bath", cost: 10.15 },
  { sku: "caddy-long-012", nameAr: "الوعاء الأحفوري - الطويل", nameEn: "Diatomite Caddy - Long", price: 28, category: "bath", cost: 2.5 },
  // caddy-short-013 is the fixed gift inside the three two-mat bundles.
  { sku: "caddy-short-013", nameAr: "الوعاء الأحفوري - القصير", nameEn: "Diatomite Caddy - Short", price: 22, category: "bath", cost: 2.5 },
  { sku: "caddy-oval-014", nameAr: "الوعاء الأحفوري - البيضاوي", nameEn: "Diatomite Caddy - Oval", price: 22, category: "bath", cost: 2.5 },
  // Kitchen.
  { sku: "flodable-dish-020", nameAr: "قاعدة تجفيف الصحون الاحفورية", nameEn: "Diatomite Foldable Dish Rack", price: 299, category: "kitchen", cost: 18.75 },
  { sku: "caddy-coaster-015", nameAr: "قاعدة الاكواب الاحفورية", nameEn: "Diatomite Cup Coaster", price: 22, category: "kitchen" },
  { sku: "bowl-small-017", nameAr: "وعاء صغير", nameEn: "Small Bowl", price: 30, category: "kitchen" },
  { sku: "bowl-large-016", nameAr: "وعاء كبير", nameEn: "Large Bowl", price: 30, category: "kitchen" },
  // Pets. The Fast Hub SKUs really are capitalised `Pets-…`. The costing
  // sheet prices مفرد (19.80) and مزدوج (22.80) but Fast Hub sells كبير and
  // صغير — which size مفرد corresponds to is unresolved, so both keep 0.
  { sku: "Pets-large-005", nameAr: "قاعدة أوعية الحيوانات - كبير", nameEn: "Pet Bowl Stand - Large", price: 199, category: "pets" },
  { sku: "Pets-small-006", nameAr: "قاعدة أوعية الحيوانات - صغير", nameEn: "Pet Bowl Stand - Small", price: 199, category: "pets" },
  { sku: "PENDING-pets-double", nameAr: "قاعدة أوعية الحيوانات - مزدوج", nameEn: "Pet Bowl Stand - Double", price: 389, category: "pets", cost: 22.8 },
];

/**
 * Bundles exist only in Salla and are assembled at pick time (`isBundle`).
 *
 * NONE of them gets a `BundleComponent` recipe here, on purpose:
 * - Four of the five are customer-configured, so the components come from the
 *   order, never from a stored recipe. Storing just the fixed gift would be
 *   worse than storing nothing — an order expanded against a gift-only recipe
 *   would silently deplete the gift and miss both mats, while an empty recipe
 *   makes `expandSaleLines` throw `BUNDLE_RECIPE_MISSING`, which is loud.
 * - The kitchen kit is the one fixed bundle, but its exact four components
 *   are still unconfirmed (ask the owner, or read one real Fast Hub order).
 *   Fill it via `setBundleRecipe` the day they are confirmed.
 */
const BUNDLES: { sku: string; nameAr: string; nameEn: string; price: number; noteAr?: string; noteEn?: string }[] = [
  { sku: "kitchen-kit-111", nameAr: "باقة المطبخ المتكاملة", nameEn: "Complete Kitchen Kit", price: 259 },
  { sku: "bath-kit-111", nameAr: "باقة الحمام المتكاملة", nameEn: "Complete Bath Kit", price: 239 },
  {
    sku: "PENDING-two-mats-mix", nameAr: "باقة الحمامين (مزيج) + هدية", nameEn: "Two Bath Mats (Mix) + Gift", price: 339,
    noteAr: "تشمل هدية ثابتة: الوعاء الأحفوري - القصير (caddy-short-013)",
    noteEn: "Includes a fixed gift: Diatomite Caddy - Short (caddy-short-013)",
  },
  {
    sku: "PENDING-two-mats-drops", nameAr: "باقة الحمامين (قطرات) + هدية", nameEn: "Two Bath Mats (Drops) + Gift", price: 339,
    noteAr: "تشمل هدية ثابتة: الوعاء الأحفوري - القصير (caddy-short-013)",
    noteEn: "Includes a fixed gift: Diatomite Caddy - Short (caddy-short-013)",
  },
  {
    sku: "PENDING-two-mats-waves", nameAr: "باقة الحمامين (أمواج) + هدية", nameEn: "Two Bath Mats (Waves) + Gift", price: 339,
    noteAr: "تشمل هدية ثابتة: الوعاء الأحفوري - القصير (caddy-short-013)",
    noteEn: "Includes a fixed gift: Diatomite Caddy - Short (caddy-short-013)",
  },
];

async function main() {
  // The owner has already saved their REAL Fast Hub credentials through the
  // settings screen. A reseed must never cost them that: the ciphertext is
  // keyed off AUTH_SECRET, not the company id, so the row survives being
  // re-attached to the freshly seeded company.
  const fastHub = await prisma.fastHubConnection.findFirst();
  if (fastHub) console.log("Preserving the saved Fast Hub connection...");

  console.log("Clearing existing data...");
  // `company.deleteMany()` trips FK violations: child↔child relations like
  // order items → products carry no cascade, and SQLite may reach the product
  // before the item. Same fix as tests/factories.ts — constraints off, wipe
  // every table, constraints back on. The PRAGMA must sit outside any
  // transaction or SQLite silently ignores it.
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        AND name != '_prisma_migrations'`,
  );
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  try {
    await prisma.$transaction(
      tables.map(({ name }) => prisma.$executeRawUnsafe(`DELETE FROM "${name}"`)),
    );
  } finally {
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }

  console.log("Registering SokuDry...");
  const { userId, companyId } = await registerCompany({
    fullName: "Thomas",
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    companyName: "SokuDry",
    preferredLanguage: "ar",
  });
  const ctx = { companyId, userId };

  if (fastHub) {
    const { id: _id, companyId: _oldCompany, ...connection } = fastHub;
    await prisma.fastHubConnection.create({ data: { ...connection, companyId } });
    console.log("Fast Hub connection restored onto the new company.");
  }

  // Opening balances are unknown and are therefore not invented; both
  // accounts start at zero until the owner states the real figures.
  await completeOnboarding(ctx, {
    currencyCode: "SAR",
    defaultTaxRatePct: 1500,
    warehouseName: "Fast Hub (Riyadh)",
  });

  // The warehouse code IS the Fast Hub hub code: this warehouse is not ours,
  // it is their hub, and the inventory sync addresses the hub by this code.
  // Kept on the warehouse rather than a new column on the connection so the
  // owner can correct it from the warehouses screen without a schema change.
  //
  // "01", not "FH-Main". The dashboard shows FH-Main as the hub NAME and 01 as
  // the hub CODE in a separate column; the API answers `Invalid hub code` for
  // the name. Confirmed against the live endpoint 2026-08-04 — the orders
  // payload also stamps `hub_code: "01"` on every order.
  await prisma.warehouse.updateMany({
    where: { companyId, isDefault: true },
    data: { code: "01", city: "Riyadh" },
  });

  console.log("Creating categories...");
  const categoryDefs = {
    bath: { nameAr: "الحمام", nameEn: "Bath" },
    kitchen: { nameAr: "المطبخ", nameEn: "Kitchen" },
    pets: { nameAr: "الحيوانات الأليفة", nameEn: "Pets" },
    sets: { nameAr: "المجموعات", nameEn: "Sets" },
  } as const;
  const categories = {} as Record<keyof typeof categoryDefs, string>;
  for (const [key, def] of Object.entries(categoryDefs)) {
    const row = await prisma.productCategory.create({ data: { companyId, ...def } });
    categories[key as keyof typeof categoryDefs] = row.id;
  }

  const brand = await prisma.brand.create({ data: { companyId, name: "SokuDry" } });

  console.log("Creating products...");
  for (const p of PRODUCTS) {
    await prisma.product.create({
      data: {
        companyId, categoryId: categories[p.category], brandId: brand.id,
        nameAr: p.nameAr, nameEn: p.nameEn, sku: p.sku,
        sellingPrice: toMinor(p.price),
        ...(p.cost !== undefined ? { purchasePrice: toMinor(p.cost) } : {}),
        ...(p.archived ? { status: "ARCHIVED" } : {}),
      },
    });
  }

  console.log("Creating bundles...");
  for (const b of BUNDLES) {
    await prisma.product.create({
      data: {
        companyId, categoryId: categories.sets, brandId: brand.id,
        nameAr: b.nameAr, nameEn: b.nameEn, sku: b.sku,
        sellingPrice: toMinor(b.price),
        isBundle: true,
        // A bundle is assembled at pick time and never sits on a shelf.
        trackInventory: false,
        ...(b.noteAr ? { descriptionAr: b.noteAr, descriptionEn: b.noteEn } : {}),
      },
    });
  }

  const productCount = await prisma.product.count({ where: { companyId } });
  const pendingCount = PRODUCTS.filter((p) => p.sku.startsWith("PENDING-")).length
    + BUNDLES.filter((b) => b.sku.startsWith("PENDING-")).length;
  console.log(`\nSeed complete.`);
  console.log(`  Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  ${productCount} products (${BUNDLES.length} bundles), ${pendingCount} with PENDING skus awaiting the real Fast Hub SKU`);
  console.log(`  Purchase prices from the owner's costing sheet where known; no stock or transactions seeded — quantities come from the Fast Hub opening import/sync.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

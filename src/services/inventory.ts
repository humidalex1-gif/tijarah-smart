import type { Tx } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import type { MovementType, StockBucket } from "@/lib/constants";
import { costOf } from "@/lib/money";
import { newAverageCost } from "@/services/costing";
import { insufficientStock, notFound, invalidState } from "@/services/errors";

/**
 * Bucket behaviour as data rather than branches.
 *
 * These are `Record<StockBucket, …>`, so adding a member to StockBucket is a
 * COMPILE error here instead of a silent fall-through. That matters because
 * every bucket decision below used to be `bucket === "DAMAGED"` with an else,
 * which meant a new bucket would quietly land in availableQty and fold its
 * cost into avgCost — the exact inverse of what a new bucket is ever added for.
 */
type BucketColumn = "availableQty" | "damagedQty" | "disputedQty";

const BUCKET_COLUMN: Record<StockBucket, BucketColumn> = {
  AVAILABLE: "availableQty",
  DAMAGED: "damagedQty",
  DISPUTED: "disputedQty",
};

/** Only a bucket that represents owned, sellable stock moves the average. */
const BUCKET_MOVES_AVERAGE: Record<StockBucket, boolean> = {
  AVAILABLE: true,
  DAMAGED: false,
  // A disputed unit was bought and averaged when it arrived. Moving it into
  // dispute is a reclassification of stock already owned, not a purchase —
  // averaging it again would count the same cost twice.
  DISPUTED: false,
};

/**
 * Whether `Company.allowNegativeInventory` may apply. DAMAGED keeps a hard
 * floor at zero regardless — a documented Stage 1A contract: damaged stock is
 * physically counted, not modeled.
 */
const BUCKET_HONOURS_NEGATIVE_SETTING: Record<StockBucket, boolean> = {
  AVAILABLE: true,
  DAMAGED: false,
  // A negative disputed quantity would mean settling more units than were ever
  // claimed. Hard floor.
  DISPUTED: false,
};

interface MovementInputBase {
  warehouseId: string;
  productId: string;
  variantId?: string | null;
  movementType: MovementType;
  /**
   * AVAILABLE (default) or DAMAGED. The DAMAGED bucket always enforces a
   * hard floor at zero and ignores `allowNegativeInventory` — deliberate,
   * since damaged stock is physically counted rather than modeled.
   */
  bucket?: StockBucket;
  /** positive, scaled quantity */
  quantity: number;
  destinationWarehouseId?: string | null;
  referenceType: string;
  referenceId: string;
  referenceNumber: string;
  reason?: string | null;
  notes?: string | null;
  movementDate?: Date;
}

/**
 * Discriminated on `direction` so a caller cannot omit `unitCost` on an IN
 * movement: an IN with no cost would silently book the receipt at the
 * balance's current average, which is plausible-looking and permanently
 * wrong once the balance is non-empty. OUT keeps `unitCost` optional and
 * defaults to the balance's avgCost (the snapshot-cost behavior returns and
 * reversals rely on).
 */
export type MovementInput =
  | (MovementInputBase & { direction: "IN"; unitCost: number })
  | (MovementInputBase & { direction: "OUT"; unitCost?: number });

export async function getBalance(
  tx: Tx,
  companyId: string,
  warehouseId: string,
  productId: string,
  variantId: string | null,
) {
  // Ownership gate runs on EVERY call, not just the create path, so a
  // pre-existing mis-scoped row can never be handed back or mutated.
  await tx.warehouse.findFirstOrThrow({ where: { id: warehouseId, companyId } });
  await tx.product.findFirstOrThrow({ where: { id: productId, companyId } });
  if (variantId) {
    await tx.productVariant.findFirstOrThrow({ where: { id: variantId, productId } });
  }

  // Look up on the non-nullable discriminator: a compound-unique input cannot
  // carry null, and SQLite would not enforce uniqueness on it anyway.
  const variantKey = variantId ?? "";
  const existing = await tx.inventoryBalance.findUnique({
    where: { warehouseId_productId_variantKey: { warehouseId, productId, variantKey } },
  });
  if (existing) {
    if (existing.companyId !== companyId) throw notFound("InventoryBalance");
    return existing;
  }

  return tx.inventoryBalance.create({
    data: { companyId, warehouseId, productId, variantId, variantKey },
  });
}

/**
 * The only sanctioned way to change stock. Writes the movement row and the
 * balance update together — never call one without the other.
 */
export async function applyMovement(
  tx: Tx,
  ctx: ServiceContext,
  input: MovementInput,
): Promise<{ unitCost: number; totalCost: number; balanceAfter: number }> {
  if (input.quantity <= 0) {
    throw invalidState("INVALID_QUANTITY", { quantity: input.quantity });
  }

  const variantId = input.variantId ?? null;
  const bucket: StockBucket = input.bucket ?? "AVAILABLE";
  if (input.destinationWarehouseId) {
    await tx.warehouse.findFirstOrThrow({
      where: { id: input.destinationWarehouseId, companyId: ctx.companyId },
    });
  }
  const balance = await getBalance(
    tx, ctx.companyId, input.warehouseId, input.productId, variantId,
  );

  const unitCost = input.unitCost ?? balance.avgCost;
  const quantities: Record<BucketColumn, number> = {
    availableQty: balance.availableQty,
    damagedQty: balance.damagedQty,
    disputedQty: balance.disputedQty,
  };
  const column = BUCKET_COLUMN[bucket];
  let avgCost = balance.avgCost;

  if (input.direction === "IN") {
    // Damaged stock carries no cost basis, so avgCost is deliberately left
    // untouched for it. Reclassifying AVAILABLE -> DAMAGED (an OUT against
    // AVAILABLE followed by an IN into DAMAGED) writes that value off:
    // inventory value is derived from availableQty x avgCost only.
    if (BUCKET_MOVES_AVERAGE[bucket]) {
      avgCost = newAverageCost({
        oldQty: quantities[column],
        oldAvgCost: avgCost,
        receivedQty: input.quantity,
        receivedUnitCost: unitCost,
      });
    }
    quantities[column] += input.quantity;
  } else {
    if (quantities[column] < input.quantity) {
      let permitted = false;
      if (BUCKET_HONOURS_NEGATIVE_SETTING[bucket]) {
        const company = await tx.company.findUniqueOrThrow({
          where: { id: ctx.companyId },
          select: { allowNegativeInventory: true },
        });
        permitted = company.allowNegativeInventory;
      }
      if (!permitted) {
        throw insufficientStock({
          productId: input.productId,
          warehouseId: input.warehouseId,
          requested: input.quantity,
          available: quantities[column],
        });
      }
    }
    quantities[column] -= input.quantity;
  }

  const totalCost = costOf(input.quantity, unitCost);
  const balanceAfter = quantities[column];

  // Read-modify-write on the balance row: this assumes a single serialized
  // writer per transaction (true under better-sqlite3's implicit
  // transaction lock). If the adapter ever changes to one that allows
  // concurrent writers, this needs a row lock or atomic increments instead.
  // Documented contract, not a fix.
  await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      availableQty: quantities.availableQty,
      damagedQty: quantities.damagedQty,
      disputedQty: quantities.disputedQty,
      avgCost,
    },
  });

  await tx.inventoryMovement.create({
    data: {
      companyId: ctx.companyId,
      warehouseId: input.warehouseId,
      destinationWarehouseId: input.destinationWarehouseId ?? null,
      productId: input.productId,
      variantId,
      movementType: input.movementType,
      direction: input.direction,
      bucket,
      quantity: input.quantity,
      unitCost,
      totalCost,
      balanceAfter,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      referenceNumber: input.referenceNumber,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      movementDate: input.movementDate ?? new Date(),
      createdById: ctx.userId,
    },
  });

  return { unitCost, totalCost, balanceAfter };
}

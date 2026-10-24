"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor, toQty, toCost } from "@/lib/money";
import {
  createProduct, updateProduct, archiveProduct, createVariant, updateVariant,
} from "@/services/products";
import { createCategory, createBrand } from "@/services/catalog";
import { receiveStockManual } from "@/services/stock";
import { ServiceError } from "@/services/errors";

// Empty/absent -> undefined ("leave unset" on create; "leave unchanged" on
// update), matching the pattern in onboarding/actions.ts's
// `optionalNonNegativeAmount`. Every numeric field on this form is optional
// at the schema level — `createProduct`/`updateProduct` apply their own
// defaults/validation — so a blank input never reaches `toMinor`/`toQty`'s
// `ServiceError("INVALID_AMOUNT"/"INVALID_QUANTITY")` guards as an
// unhandled failure.
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalAmount = z.preprocess(emptyToUndefined, z.coerce.number().finite().min(0).optional());
const optionalQty = z.preprocess(emptyToUndefined, z.coerce.number().finite().min(0).optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().finite().int().min(0).optional());
const checkbox = z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean());

const productFields = {
  nameAr: z.string().min(1),
  nameEn: z.string().min(1),
  sku: z.string().min(1),
  barcode: optionalText,
  categoryId: optionalText,
  brandId: optionalText,
  descriptionAr: optionalText,
  descriptionEn: optionalText,
  purchasePrice: optionalAmount,
  sellingPrice: optionalAmount,
  wholesalePrice: optionalAmount,
  minSellingPrice: optionalAmount,
  taxRate: z.preprocess(emptyToUndefined, z.coerce.number().finite().min(0).max(100).optional()),
  weightGrams: optionalInt,
  lengthMm: optionalInt,
  widthMm: optionalInt,
  heightMm: optionalInt,
  reorderLevel: optionalQty,
  reorderQty: optionalQty,
  trackInventory: checkbox,
  allowBackorder: checkbox,
};

function toServiceInput(input: z.infer<z.ZodObject<typeof productFields>>) {
  return {
    nameAr: input.nameAr,
    nameEn: input.nameEn,
    sku: input.sku,
    barcode: input.barcode ?? null,
    categoryId: input.categoryId ?? null,
    brandId: input.brandId ?? null,
    descriptionAr: input.descriptionAr ?? null,
    descriptionEn: input.descriptionEn ?? null,
    purchasePrice: input.purchasePrice !== undefined ? toMinor(input.purchasePrice) : undefined,
    sellingPrice: input.sellingPrice !== undefined ? toMinor(input.sellingPrice) : undefined,
    wholesalePrice: input.wholesalePrice !== undefined ? toMinor(input.wholesalePrice) : undefined,
    minSellingPrice:
      input.minSellingPrice !== undefined ? toMinor(input.minSellingPrice) : undefined,
    taxRatePct: input.taxRate !== undefined ? Math.round(input.taxRate * 100) : undefined,
    weightGrams: input.weightGrams,
    lengthMm: input.lengthMm,
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    reorderLevel: input.reorderLevel !== undefined ? toQty(input.reorderLevel) : undefined,
    reorderQty: input.reorderQty !== undefined ? toQty(input.reorderQty) : undefined,
    trackInventory: input.trackInventory,
    allowBackorder: input.allowBackorder,
  };
}

// A quantity with no purchase price would otherwise receive stock at
// unitCost 0 — a permanent zero cost basis that then displays as SAR 0.00
// inventory value and a false 100% margin. A quantity with no warehouse
// would silently drop the receipt entirely (the old `&&
// input.openingWarehouseId` condition below), creating the product while the
// merchant believes stock was entered. Both are field-level validation
// errors, enforced at parse time so neither the product nor any movement is
// ever written when they fail.
const createProductSchema = z.object({
  ...productFields,
  openingQty: optionalQty,
  openingWarehouseId: optionalText,
}).superRefine((data, ctx) => {
  if (data.openingQty !== undefined && data.openingQty > 0) {
    if (data.purchasePrice === undefined || data.purchasePrice <= 0) {
      // A dictionary KEY, not English text: action()'s VALIDATION branch
      // copies `issue.message` verbatim into `state.fields[...]`, and
      // ProductForm renders that string next to the input, so a
      // hand-authored sentence here would show untranslated English to an
      // Arabic merchant on this field. ProductForm resolves it through the
      // same `labels.errors` map as every other action error code.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purchasePrice"],
        message: "errors.OPENING_PRICE_REQUIRED",
      });
    }
    if (!data.openingWarehouseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingWarehouseId"],
        message: "errors.OPENING_WAREHOUSE_REQUIRED",
      });
    }
  }
});

export const createProductAction = action({
  // products.create alone understates what this handler actually does: when
  // opening quantity is given, the handler below also posts real stock via
  // receiveStockManual (see the comment on that call), so a role that can
  // create a product but not receive stock must not reach this. Declaring
  // both is currently a no-op — every role holding products.create (OWNER,
  // ADMIN, WAREHOUSE_MANAGER) also holds inventory.receive per the Stage 1
  // matrix (src/lib/permissions.ts) — but it stops that alignment from being
  // an accident this action silently depends on.
  permission: ["products.create", "inventory.receive"],
  schema: createProductSchema,
  handler: async (input, ctx) => {
    const product = await createProduct(ctx, toServiceInput(input));

    // Opening stock is optional and, unlike every other product field, is
    // not part of the Product row itself — it is a real stock movement, so
    // it goes through the same `receiveStockManual` the Inventory screens
    // use rather than a bespoke write inside `createProduct`'s transaction.
    // The schema's superRefine above guarantees purchasePrice and
    // openingWarehouseId are both present whenever openingQty is, so this
    // condition mirrors it rather than re-deciding anything.
    if (input.openingQty && input.openingQty > 0 && input.openingWarehouseId
      && input.purchasePrice !== undefined) {
      // createProduct's transaction has already committed by this point, so
      // a failure here must not read as "nothing happened": the product
      // exists, only its opening stock is missing. Report that plainly
      // instead of letting it fall through to the generic error, which would
      // leave the merchant unsure whether the create itself failed.
      try {
        await receiveStockManual(ctx, {
          warehouseId: input.openingWarehouseId,
          productId: product.id,
          quantity: toQty(input.openingQty),
          unitCost: toCost(toMinor(input.purchasePrice)),
          reason: "Opening balance",
        });
      } catch (error) {
        // A ServiceError thrown here never reaches action()'s own
        // `console.error` (that branch only fires on the generic/unexpected
        // path), so without logging here a real receiveStockManual fault —
        // e.g. an AMOUNT_OUT_OF_RANGE on a huge opening quantity — would be
        // invisible server-side. Log first, then decide how to report it.
        console.error("Opening stock receipt failed after product create:", error);
        // A specific, actionable code — whether receiveStockManual's own
        // guard (e.g. QUANTITY_MUST_BE_POSITIVE) or lib/money.ts's overflow
        // guard (e.g. AMOUNT_OUT_OF_RANGE), both now ServiceError (decisions
        // #9) — is more useful to the merchant than the generic
        // OPENING_STOCK_FAILED wrap, so it's preserved here rather than
        // masked: `error` (not OPENING_STOCK_FAILED) is what's thrown below.
        // ProductForm's `labels.errors` map (new/page.tsx, edit/page.tsx)
        // must list every code this can actually be — QUANTITY_MUST_BE_POSITIVE,
        // AMOUNT_OUT_OF_RANGE, INVALID_PRICE, INVALID_SKU, INVALID_TAX_RATE —
        // or "preserved" only holds up to this catch, not to the screen the
        // merchant actually sees (Stage 1B review, IMPORTANT 6: this used to
        // claim "preserved" while the label map only wired the generic
        // fallback for every one of these).
        // Only a genuinely unrecognized failure falls through to the
        // generic wrap below.
        if (error instanceof ServiceError) throw error;
        throw new ServiceError("OPENING_STOCK_FAILED", {
          productId: product.id, sku: product.sku,
        });
      }
    }

    return { id: product.id };
  },
});

export const updateProductAction = action({
  permission: "products.edit",
  schema: z.object({ id: z.string().min(1), ...productFields }),
  handler: async (input, ctx) => {
    const { id, ...rest } = input;
    const product = await updateProduct(ctx, id, toServiceInput(rest));
    return { id: product.id };
  },
});

export const archiveProductAction = action({
  permission: "products.archive",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (input, ctx) => {
    const product = await archiveProduct(ctx, input.id);
    return { id: product.id };
  },
});

export const createCategoryAction = action({
  permission: "products.create",
  schema: z.object({
    nameAr: z.string().min(1), nameEn: z.string().min(1), parentId: optionalText,
  }),
  handler: async (input, ctx) => createCategory(ctx, input),
});

export const createBrandAction = action({
  permission: "products.create",
  schema: z.object({ name: z.string().min(1) }),
  handler: async (input, ctx) => createBrand(ctx, input),
});

// Attribute pairs arrive as two parallel, same-length arrays of form field
// values, posted under the repeated names `attrName`/`attrValue` (the
// variant form renders one pair of inputs per attribute row, all sharing
// those two names) rather than JSON, since a plain <form> only ever posts
// flat string fields. `action()` (src/lib/action.ts) collapses a repeated
// FormData key into an array via `formData.getAll` before this schema ever
// sees it, so a single attribute row posts as a string and two or more post
// as a string[] — the union below is what actually receives each shape.
const variantFields = {
  name: z.string().min(1),
  sku: z.string().min(1),
  barcode: optionalText,
  attrName: z.union([z.string(), z.array(z.string())]).optional(),
  attrValue: z.union([z.string(), z.array(z.string())]).optional(),
  purchasePrice: optionalAmount,
  sellingPrice: optionalAmount,
  wholesalePrice: optionalAmount,
  minSellingPrice: optionalAmount,
  weightGrams: optionalInt,
};

function buildAttributes(input: {
  attrName?: string | string[]; attrValue?: string | string[];
}): Record<string, string> {
  const names = input.attrName === undefined ? [] : ([] as string[]).concat(input.attrName);
  const values = input.attrValue === undefined ? [] : ([] as string[]).concat(input.attrValue);
  const attributes: Record<string, string> = {};
  names.forEach((name, i) => {
    if (name.trim() !== "" && values[i]?.trim()) attributes[name.trim()] = values[i].trim();
  });
  return attributes;
}

export const createVariantAction = action({
  permission: "products.create",
  schema: z.object({ productId: z.string().min(1), ...variantFields }),
  handler: async (input, ctx) => {
    const variant = await createVariant(ctx, input.productId, {
      name: input.name,
      sku: input.sku,
      barcode: input.barcode ?? null,
      attributes: buildAttributes(input),
      purchasePrice: input.purchasePrice !== undefined ? toMinor(input.purchasePrice) : undefined,
      sellingPrice: input.sellingPrice !== undefined ? toMinor(input.sellingPrice) : undefined,
      wholesalePrice:
        input.wholesalePrice !== undefined ? toMinor(input.wholesalePrice) : undefined,
      minSellingPrice:
        input.minSellingPrice !== undefined ? toMinor(input.minSellingPrice) : undefined,
      weightGrams: input.weightGrams,
    });
    return { id: variant.id };
  },
});

export const updateVariantAction = action({
  permission: "products.edit",
  schema: z.object({ id: z.string().min(1), ...variantFields }),
  handler: async (input, ctx) => {
    const variant = await updateVariant(ctx, input.id, {
      name: input.name,
      sku: input.sku,
      barcode: input.barcode ?? null,
      attributes: buildAttributes(input),
      purchasePrice: input.purchasePrice !== undefined ? toMinor(input.purchasePrice) : undefined,
      sellingPrice: input.sellingPrice !== undefined ? toMinor(input.sellingPrice) : undefined,
      wholesalePrice:
        input.wholesalePrice !== undefined ? toMinor(input.wholesalePrice) : undefined,
      minSellingPrice:
        input.minSellingPrice !== undefined ? toMinor(input.minSellingPrice) : undefined,
      weightGrams: input.weightGrams,
    });
    return { id: variant.id };
  },
});

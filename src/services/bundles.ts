import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { invalidState } from "@/services/errors";
import { writeAudit } from "@/services/audit";

/**
 * Bundles — products assembled at pick time rather than stocked as units.
 *
 * A bundle has no shelf of its own. Selling one must remove its COMPONENTS from
 * stock; without that, the sale depletes nothing and the units resurface at the
 * next reconciliation as unexplained shrinkage, with the app accusing the
 * warehouse of losing goods that were in fact sold.
 *
 * Recipes here are the FIXED case only. Four of the five bundles in this
 * catalogue let the customer choose their components, so the components picked
 * for a given order beat any stored recipe — see `expandSaleLines`.
 */

export type SaleLine = {
  productId: string;
  variantId?: string | null;
  quantity: number;
  /**
   * What was actually picked for this line, when the source knows. Supplied by
   * the warehouse, it is the truth and the stored recipe is ignored.
   */
  components?: { productId: string; variantId?: string | null; quantity: number }[];
};

export type ExpandedLine = {
  productId: string;
  variantId?: string | null;
  quantity: number;
};

export async function bundleRecipe(companyId: string, bundleProductId: string) {
  return prisma.bundleComponent.findMany({
    where: { companyId, bundleProductId },
    orderBy: { componentProductId: "asc" },
  });
}

/**
 * Replaces a bundle's recipe wholesale. An empty component list unmakes the
 * bundle, so a product mistakenly marked as one can be corrected.
 */
export async function setBundleRecipe(
  ctx: ServiceContext,
  input: {
    bundleProductId: string;
    components: { productId: string; quantity: number }[];
  },
): Promise<void> {
  for (const component of input.components) {
    if (component.quantity <= 0) {
      throw invalidState("BUNDLE_INVALID_QUANTITY", { quantity: component.quantity });
    }
    // One level of nesting is all this model supports; a self-reference would
    // recurse forever the moment a sale was expanded.
    if (component.productId === input.bundleProductId) {
      throw invalidState("BUNDLE_SELF_REFERENCE", { productId: component.productId });
    }
  }

  const ids = [input.bundleProductId, ...input.components.map((c) => c.productId)];
  const owned = await prisma.product.findMany({
    where: { id: { in: [...new Set(ids)] }, companyId: ctx.companyId },
    select: { id: true },
  });
  if (owned.length !== new Set(ids).size) {
    throw invalidState("NOT_FOUND", { entity: "Product" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.bundleComponent.deleteMany({
      where: { companyId: ctx.companyId, bundleProductId: input.bundleProductId },
    });

    for (const component of input.components) {
      await tx.bundleComponent.create({
        data: {
          companyId: ctx.companyId,
          bundleProductId: input.bundleProductId,
          componentProductId: component.productId,
          quantity: component.quantity,
        },
      });
    }

    await tx.product.update({
      where: { id: input.bundleProductId },
      data: { isBundle: input.components.length > 0 },
    });

    await writeAudit(tx, ctx, {
      action: "BUNDLE_RECIPE_SET",
      entityType: "Product",
      entityId: input.bundleProductId,
      newValues: {
        components: input.components.map((c) => ({
          productId: c.productId,
          quantity: c.quantity,
        })),
      },
    });
  });
}

/**
 * Turns sold lines into the lines that actually move stock.
 *
 * Ordinary products pass through untouched. A bundle is replaced by its
 * components, each multiplied by how many bundles were sold. Components that
 * also appear as their own line are merged, so buying a kit plus a spare mat
 * takes three mats off one line rather than producing two movements for the
 * same product.
 */
export async function expandSaleLines(
  companyId: string,
  lines: SaleLine[],
): Promise<ExpandedLine[]> {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, companyId },
    select: { id: true, isBundle: true },
  });
  const isBundle = new Map(products.map((p) => [p.id, p.isBundle]));

  const bundleIds = lines
    .filter((l) => isBundle.get(l.productId) === true && !l.components)
    .map((l) => l.productId);
  const recipes = bundleIds.length === 0 ? [] : await prisma.bundleComponent.findMany({
    where: { companyId, bundleProductId: { in: [...new Set(bundleIds)] } },
  });
  const recipeBy = new Map<string, typeof recipes>();
  for (const row of recipes) {
    const list = recipeBy.get(row.bundleProductId) ?? [];
    list.push(row);
    recipeBy.set(row.bundleProductId, list);
  }

  const merged = new Map<string, ExpandedLine>();
  const add = (line: ExpandedLine) => {
    const key = `${line.productId}:${line.variantId ?? ""}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += line.quantity;
    else merged.set(key, { ...line });
  };

  for (const line of lines) {
    // Supplied components win: the warehouse knows which colour it picked, and
    // no stored recipe can know that for a customer-configured bundle.
    if (line.components && line.components.length > 0) {
      for (const component of line.components) {
        add({
          productId: component.productId,
          variantId: component.variantId ?? null,
          quantity: component.quantity,
        });
      }
      continue;
    }

    if (isBundle.get(line.productId) !== true) {
      add({ productId: line.productId, variantId: line.variantId ?? null, quantity: line.quantity });
      continue;
    }

    const recipe = recipeBy.get(line.productId) ?? [];
    if (recipe.length === 0) {
      // Returning nothing here would reproduce the exact defect this module
      // exists to fix: a sale that moves no stock and surfaces as loss later.
      throw invalidState("BUNDLE_RECIPE_MISSING", { productId: line.productId });
    }

    for (const component of recipe) {
      add({
        productId: component.componentProductId,
        variantId: null,
        // Quantities are thousandths on both sides, so the product of two of
        // them carries the scale twice and has to come back down once.
        quantity: (line.quantity * component.quantity) / 1000,
      });
    }
  }

  return [...merged.values()];
}

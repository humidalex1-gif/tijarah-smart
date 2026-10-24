import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty } from "@/lib/money";
import { setBundleRecipe, expandSaleLines, bundleRecipe } from "@/services/bundles";
import { makeCompany, makeProduct, makeCtx, resetDb } from "../../tests/factories";

async function catalogue() {
  const company = await makeCompany();
  const ctx = makeCtx(company.id);
  const kit = await makeProduct(company.id, "kitchen-kit-111");
  const mat = await makeProduct(company.id, "waves-light-004");
  const caddy = await makeProduct(company.id, "caddy-short-013");
  const holder = await makeProduct(company.id, "holder-dark-018");
  return { company, ctx, kit, mat, caddy, holder };
}

describe("setBundleRecipe", () => {
  beforeEach(resetDb);

  it("marks the parent as a bundle and stores its lines", async () => {
    const { ctx, kit, mat, caddy } = await catalogue();

    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [
        { productId: mat.id, quantity: toQty(1) },
        { productId: caddy.id, quantity: toQty(2) },
      ],
    });

    const parent = await prisma.product.findUniqueOrThrow({ where: { id: kit.id } });
    expect(parent.isBundle).toBe(true);
    expect(await bundleRecipe(ctx.companyId, kit.id)).toHaveLength(2);
  });

  it("replaces the recipe rather than appending to it", async () => {
    const { ctx, kit, mat, caddy } = await catalogue();
    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: mat.id, quantity: toQty(1) }],
    });

    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: caddy.id, quantity: toQty(1) }],
    });

    const recipe = await bundleRecipe(ctx.companyId, kit.id);
    expect(recipe).toHaveLength(1);
    expect(recipe[0].componentProductId).toBe(caddy.id);
  });

  it("refuses a bundle that contains itself", async () => {
    // One level of nesting is all this model supports, and a self-reference
    // would recurse forever when a sale is expanded.
    const { ctx, kit } = await catalogue();

    await expect(setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: kit.id, quantity: toQty(1) }],
    })).rejects.toThrow();
  });

  it("refuses a component from another company", async () => {
    const { ctx, kit } = await catalogue();
    const other = await makeCompany("Other Co");
    const theirs = await makeProduct(other.id, "THEIR-SKU");

    await expect(setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: theirs.id, quantity: toQty(1) }],
    })).rejects.toThrow();
  });

  it("refuses a non-positive component quantity", async () => {
    const { ctx, kit, mat } = await catalogue();

    await expect(setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: mat.id, quantity: 0 }],
    })).rejects.toThrow();
  });

  it("clears the bundle flag when the recipe is emptied", async () => {
    const { ctx, kit, mat } = await catalogue();
    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: mat.id, quantity: toQty(1) }],
    });

    await setBundleRecipe(ctx, { bundleProductId: kit.id, components: [] });

    const parent = await prisma.product.findUniqueOrThrow({ where: { id: kit.id } });
    expect(parent.isBundle).toBe(false);
  });
});

describe("expandSaleLines", () => {
  beforeEach(resetDb);

  it("leaves an ordinary product untouched", async () => {
    const { ctx, mat } = await catalogue();

    const lines = await expandSaleLines(ctx.companyId, [
      { productId: mat.id, quantity: toQty(3) },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: mat.id, quantity: toQty(3) });
  });

  it("replaces a bundle with its components, multiplied by the sold quantity", async () => {
    // THE defect this exists for: a bundle has no shelf of its own, so selling
    // one currently depletes nothing and the units later surface as unexplained
    // shrinkage — the app accusing the warehouse of losing goods that were sold.
    const { ctx, kit, mat, caddy } = await catalogue();
    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [
        { productId: mat.id, quantity: toQty(1) },
        { productId: caddy.id, quantity: toQty(2) },
      ],
    });

    const lines = await expandSaleLines(ctx.companyId, [
      { productId: kit.id, quantity: toQty(3) },
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.productId === mat.id)!.quantity).toBe(toQty(3));
    expect(lines.find((l) => l.productId === caddy.id)!.quantity).toBe(toQty(6));
    expect(lines.some((l) => l.productId === kit.id)).toBe(false);
  });

  it("merges a component that also appears as its own line", async () => {
    // Buying the kit and a spare mat must take three mats off one line, not two
    // lines that each look like a separate movement.
    const { ctx, kit, mat } = await catalogue();
    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: mat.id, quantity: toQty(1) }],
    });

    const lines = await expandSaleLines(ctx.companyId, [
      { productId: kit.id, quantity: toQty(2) },
      { productId: mat.id, quantity: toQty(1) },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(toQty(3));
  });

  it("honours components supplied with the line over the stored recipe", async () => {
    // Four of the five bundles let the customer choose. When the warehouse tells
    // us what was actually picked, that beats any recipe we hold.
    const { ctx, kit, mat, caddy, holder } = await catalogue();
    await setBundleRecipe(ctx, {
      bundleProductId: kit.id,
      components: [{ productId: mat.id, quantity: toQty(1) }],
    });

    const lines = await expandSaleLines(ctx.companyId, [
      {
        productId: kit.id,
        quantity: toQty(1),
        components: [
          { productId: caddy.id, quantity: toQty(1) },
          { productId: holder.id, quantity: toQty(1) },
        ],
      },
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.productId === mat.id)).toBe(false);
    expect(lines.some((l) => l.productId === caddy.id)).toBe(true);
    expect(lines.some((l) => l.productId === holder.id)).toBe(true);
  });

  it("refuses a bundle with no recipe rather than silently depleting nothing", async () => {
    // Returning an empty expansion would reproduce the exact bug: a sale that
    // moves no stock and shows up as loss months later.
    const { ctx, kit } = await catalogue();
    await prisma.product.update({ where: { id: kit.id }, data: { isBundle: true } });

    await expect(
      expandSaleLines(ctx.companyId, [{ productId: kit.id, quantity: toQty(1) }]),
    ).rejects.toThrow();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u1", companyId: "c1", role: "OWNER" as const };
vi.mock("@/lib/auth", () => ({ requireSession: vi.fn(async () => session) }));
// The JWT is a cache, not authority (docs/decisions.md #2) — action() re-reads
// Membership, so the test has to control that read (same pattern as
// src/lib/action.test.ts).
vi.mock("@/lib/db", () => ({
  prisma: { membership: { findFirst: vi.fn(async () => ({ role: "OWNER" })) } },
}));
vi.mock("@/services/products", () => ({
  createProduct: vi.fn(async () => ({ id: "prod-1", sku: "SHIRT-1" })),
  updateProduct: vi.fn(),
  archiveProduct: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
}));
vi.mock("@/services/stock", () => ({
  receiveStockManual: vi.fn(async () => ({ movementId: "mv-1", referenceNumber: "RCV-1" })),
}));
vi.mock("@/services/catalog", () => ({
  createCategory: vi.fn(),
  createBrand: vi.fn(),
}));

const { ServiceError } = await import("@/services/errors");
const { createProductAction, createVariantAction } = await import("./actions");
const { requireSession } = await import("@/lib/auth");
const { prisma } = await import("@/lib/db");
const { createProduct, createVariant } = await import("@/services/products");
const { receiveStockManual } = await import("@/services/stock");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

const validProduct = { nameAr: "قميص", nameEn: "Shirt", sku: "SHIRT-1" };

describe("createProductAction opening stock validation", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue(session);
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(createProduct).mockClear();
    vi.mocked(createProduct).mockResolvedValue({ id: "prod-1", sku: "SHIRT-1" } as never);
    vi.mocked(receiveStockManual).mockClear();
    vi.mocked(receiveStockManual).mockResolvedValue(
      { movementId: "mv-1", referenceNumber: "RCV-1" } as never,
    );
  });

  it("rejects an opening quantity with a blank purchase price, and writes nothing", async () => {
    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION");
      // A dictionary KEY, not the hand-authored English sentence this used
      // to be — ProductForm resolves it through `labels.errors` before
      // display, so an Arabic merchant never sees this raw string.
      expect(result.fields?.purchasePrice).toBe("errors.OPENING_PRICE_REQUIRED");
    }
    expect(createProduct).not.toHaveBeenCalled();
    expect(receiveStockManual).not.toHaveBeenCalled();
  });

  it("rejects an opening quantity with an explicit zero purchase price, and writes nothing", async () => {
    // Not just "blank" — an explicit 0 produces the exact same permanent
    // zero-cost-basis bug, so it must fail the same way.
    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1", purchasePrice: "0",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields?.purchasePrice).toBe("errors.OPENING_PRICE_REQUIRED");
    expect(createProduct).not.toHaveBeenCalled();
    expect(receiveStockManual).not.toHaveBeenCalled();
  });

  it("rejects an opening quantity with no warehouse, and writes nothing", async () => {
    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", purchasePrice: "20",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION");
      expect(result.fields?.openingWarehouseId).toBe("errors.OPENING_WAREHOUSE_REQUIRED");
    }
    expect(createProduct).not.toHaveBeenCalled();
    expect(receiveStockManual).not.toHaveBeenCalled();
  });

  it("rejects an opening quantity with neither price nor warehouse, flagging both fields", async () => {
    const result = await createProductAction(form({ ...validProduct, openingQty: "10" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields?.purchasePrice).toBe("errors.OPENING_PRICE_REQUIRED");
      expect(result.fields?.openingWarehouseId).toBe("errors.OPENING_WAREHOUSE_REQUIRED");
    }
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("allows creating a product with no opening quantity at all", async () => {
    const result = await createProductAction(form({ ...validProduct }));

    expect(result.ok).toBe(true);
    expect(createProduct).toHaveBeenCalled();
    expect(receiveStockManual).not.toHaveBeenCalled();
  });

  it("receives opening stock when both purchase price and warehouse are given", async () => {
    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1", purchasePrice: "20",
    }));

    expect(result.ok).toBe(true);
    expect(receiveStockManual).toHaveBeenCalledWith(
      { companyId: "c1", userId: "u1" },
      {
        warehouseId: "wh-1",
        productId: "prod-1",
        quantity: 10_000, // toQty(10)
        unitCost: 20_000_000, // toCost(toMinor(20))
        reason: "Opening balance",
      },
    );
  });

  it("reports a legible, distinct error when the receipt fails after the product is already created", async () => {
    // createProduct's transaction has already committed by this point in the
    // handler — the failure must not read as "nothing happened".
    vi.mocked(receiveStockManual).mockRejectedValue(new Error("boom"));

    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1", purchasePrice: "20",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("OPENING_STOCK_FAILED");
      expect(result.error).toBe("errors.OPENING_STOCK_FAILED");
    }
    // The product itself WAS created — this is a distinct, legible failure,
    // not a silent swallow that leaves the merchant unsure what happened.
    expect(createProduct).toHaveBeenCalled();
  });

  it("logs the original receipt failure server-side instead of discarding it", async () => {
    // A ServiceError never reaches action()'s own console.error (that branch
    // is generic/unexpected-only), so without logging here the real cause of
    // an OPENING_STOCK_FAILED would be invisible in the server logs.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("boom");
    vi.mocked(receiveStockManual).mockRejectedValue(original);

    await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1", purchasePrice: "20",
    }));

    expect(spy).toHaveBeenCalledWith(expect.any(String), original);
    spy.mockRestore();
  });

  it("preserves a ServiceError's own code instead of masking it as OPENING_STOCK_FAILED", async () => {
    // e.g. receiveStockManual's own QUANTITY_MUST_BE_POSITIVE guard — a
    // specific, actionable code the merchant should see, not the generic
    // "opening stock failed" wrap.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(receiveStockManual).mockRejectedValue(new ServiceError("QUANTITY_MUST_BE_POSITIVE"));

    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1", purchasePrice: "20",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("QUANTITY_MUST_BE_POSITIVE");
      expect(result.error).toBe("errors.QUANTITY_MUST_BE_POSITIVE");
    }
    vi.mocked(console.error).mockRestore();
  });

  it("preserves toCost/toMinor's own ServiceError code instead of masking it as OPENING_STOCK_FAILED", async () => {
    // e.g. toCost/toMinor's AMOUNT_OUT_OF_RANGE overflow guard (decisions.md
    // #9 — now a ServiceError, not a bare Error) on a huge opening quantity.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(receiveStockManual).mockRejectedValue(new ServiceError("AMOUNT_OUT_OF_RANGE"));

    const result = await createProductAction(form({
      ...validProduct, openingQty: "10", openingWarehouseId: "wh-1", purchasePrice: "20",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AMOUNT_OUT_OF_RANGE");
      expect(result.error).toBe("errors.AMOUNT_OUT_OF_RANGE");
    }
    vi.mocked(console.error).mockRestore();
  });
});

describe("createVariantAction attribute round-trip", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue(session);
    vi.mocked(prisma.membership.findFirst).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(createVariant).mockClear();
    vi.mocked(createVariant).mockResolvedValue({ id: "variant-1" } as never);
  });

  it("persists every attribute pair, not just the last one", async () => {
    // Regression test for the FormData-collapse bug in src/lib/action.ts:
    // Object.fromEntries(formData.entries()) used to keep only the LAST value
    // for a repeated field name, so a variant saved with Color=Red, Size=L
    // persisted only {"Size":"L"} with no error. VariantSection.tsx posts
    // attrName/attrValue as two repeated-name inputs, one pair per attribute
    // row, so this reproduces the real production form submission shape.
    const fd = new FormData();
    fd.append("productId", "prod-1");
    fd.append("name", "Red / L");
    fd.append("sku", "SHIRT-1-RED-L");
    fd.append("attrName", "Color");
    fd.append("attrValue", "Red");
    fd.append("attrName", "Size");
    fd.append("attrValue", "L");

    const result = await createVariantAction(fd);

    expect(result.ok).toBe(true);
    expect(createVariant).toHaveBeenCalledWith(
      { companyId: "c1", userId: "u1" },
      "prod-1",
      expect.objectContaining({
        attributes: { Color: "Red", Size: "L" },
      }),
    );
  });

  it("still accepts a single attribute pair (the scalar, non-repeated case)", async () => {
    const fd = new FormData();
    fd.append("productId", "prod-1");
    fd.append("name", "Red");
    fd.append("sku", "SHIRT-1-RED");
    fd.append("attrName", "Color");
    fd.append("attrValue", "Red");

    const result = await createVariantAction(fd);

    expect(result.ok).toBe(true);
    expect(createVariant).toHaveBeenCalledWith(
      { companyId: "c1", userId: "u1" },
      "prod-1",
      expect.objectContaining({ attributes: { Color: "Red" } }),
    );
  });
});

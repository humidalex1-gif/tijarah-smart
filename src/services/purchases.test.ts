import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { toQty, toCost, toMinor, costOf } from "@/lib/money";
import {
  createPurchaseOrder, confirmPurchaseOrder, receivePurchase, cancelPurchaseOrder,
} from "@/services/purchases";
import { supplierBalance } from "@/services/ledger";
import {
  makeCompany, makeWarehouse, makeProduct, makeSupplier, makeCtx, resetDb,
} from "../../tests/factories";

async function setup() {
  const company = await makeCompany();
  const warehouse = await makeWarehouse(company.id);
  const supplier = await makeSupplier(company.id);
  const productA = await makeProduct(company.id, "A", { weightGrams: 1000 });
  const productB = await makeProduct(company.id, "B", { weightGrams: 500 });
  return { company, warehouse, supplier, productA, productB, ctx: makeCtx(company.id) };
}

describe("createPurchaseOrder", () => {
  beforeEach(resetDb);

  it("numbers the order and computes totals including tax and additional costs", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();

    const result = await createPurchaseOrder(ctx, {
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      items: [{
        productId: productA.id, orderedQty: toQty(10),
        unitPrice: toMinor(100), taxRatePct: 1500,
      }],
      additionalCosts: [{ costType: "CUSTOMS", amount: toMinor(200) }],
    });

    expect(result.purchaseOrderNumber).toBe("PO-0001");
    const po = await prisma.purchaseOrder.findFirstOrThrow({ include: { items: true } });
    expect(po.status).toBe("DRAFT");
    expect(po.subtotal).toBe(toMinor(1000));
    expect(po.taxTotal).toBe(toMinor(150));
    expect(po.additionalCostTotal).toBe(toMinor(200));
    expect(po.grandTotal).toBe(toMinor(1350));
    expect(po.items[0].lineTotal).toBe(toMinor(1000));
  });

  it("subtracts line discounts before tax", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await createPurchaseOrder(ctx, {
      supplierId: supplier.id, warehouseId: warehouse.id,
      items: [{
        productId: productA.id, orderedQty: toQty(10),
        unitPrice: toMinor(100), discountAmount: toMinor(100), taxRatePct: 1000,
      }],
    });

    const po = await prisma.purchaseOrder.findFirstOrThrow({ include: { items: true } });
    expect(po.items[0].lineTotal).toBe(toMinor(900));
    expect(po.taxTotal).toBe(toMinor(90));
    expect(po.grandTotal).toBe(toMinor(990));
  });

  it("rejects an order with no items", async () => {
    const { warehouse, supplier, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id, items: [],
      }),
    ).rejects.toMatchObject({ code: "NO_LINES" });
  });

  it("rejects a non-positive ordered quantity", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        items: [{ productId: productA.id, orderedQty: 0, unitPrice: toMinor(10) }],
      }),
    ).rejects.toMatchObject({ code: "QUANTITY_MUST_BE_POSITIVE" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects a negative unit price", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        items: [{ productId: productA.id, orderedQty: toQty(1), unitPrice: -1 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PRICE" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects a discount that exceeds the line's gross value", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        items: [{
          productId: productA.id, orderedQty: toQty(1),
          unitPrice: toMinor(10), discountAmount: toMinor(11),
        }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_DISCOUNT" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects an unknown allocation method", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        allocationMethod: "BOGUS" as unknown as "VALUE",
        items: [{ productId: productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ALLOCATION_METHOD" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects MANUAL allocation with its own code (unsupported until Stage 2)", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        allocationMethod: "MANUAL",
        items: [{ productId: productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ALLOCATION_NOT_SUPPORTED" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects a negative tax rate", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        items: [{
          productId: productA.id, orderedQty: toQty(1),
          unitPrice: toMinor(10), taxRatePct: -100,
        }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_TAX_RATE" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects a negative additional-cost amount at create, not at receive", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    await expect(
      createPurchaseOrder(ctx, {
        supplierId: supplier.id, warehouseId: warehouse.id,
        items: [{ productId: productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
        additionalCosts: [{ costType: "CUSTOMS", amount: -toMinor(50) }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_COST_AMOUNT" });
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects a supplier that belongs to another company", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      createPurchaseOrder(a.ctx, {
        supplierId: b.supplier.id, warehouseId: a.warehouse.id,
        items: [{ productId: a.productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
      }),
    ).rejects.toThrow();
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });

  it("rejects a warehouse that belongs to another company", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      createPurchaseOrder(a.ctx, {
        supplierId: a.supplier.id, warehouseId: b.warehouse.id,
        items: [{ productId: a.productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
      }),
    ).rejects.toThrow();
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });
});

describe("receivePurchase", () => {
  beforeEach(resetDb);

  async function orderedTwoLines(allocationMethod: "QUANTITY" | "VALUE" | "WEIGHT" = "VALUE") {
    const s = await setup();
    const { purchaseOrderId } = await createPurchaseOrder(s.ctx, {
      supplierId: s.supplier.id,
      warehouseId: s.warehouse.id,
      allocationMethod,
      items: [
        { productId: s.productA.id, orderedQty: toQty(10), unitPrice: toMinor(100) },
        { productId: s.productB.id, orderedQty: toQty(10), unitPrice: toMinor(300) },
      ],
      additionalCosts: [{ costType: "LOCAL_SHIPPING", amount: toMinor(400) }],
    });
    await confirmPurchaseOrder(s.ctx, purchaseOrderId);
    const items = await prisma.purchaseOrderItem.findMany({ orderBy: { unitPrice: "asc" } });
    return { ...s, purchaseOrderId, itemA: items[0], itemB: items[1] };
  }

  it("adds stock at the landed cost with additional costs allocated by value", async () => {
    const { ctx, purchaseOrderId, itemA, itemB, productA } = await orderedTwoLines("VALUE");

    const result = await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [
        { purchaseOrderItemId: itemA.id, acceptedQty: toQty(10) },
        { purchaseOrderItemId: itemB.id, acceptedQty: toQty(10) },
      ],
    });

    expect(result.receiptNumber).toBe("RCP-0001");

    // Line A: 1000 goods + 100 shipping (1000/4000 of 400) => 110.00 per unit
    const balanceA = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: productA.id },
    });
    expect(balanceA.availableQty).toBe(toQty(10));
    expect(balanceA.avgCost).toBe(toCost(toMinor(110)));

    // Line B: 3000 goods + 300 shipping => 330.00 per unit
    const updatedB = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemB.id } });
    expect(updatedB.allocatedAdditionalCost).toBe(toMinor(300));
    expect(updatedB.landedUnitCost).toBe(toCost(toMinor(330)));
  });

  it("allocates additional costs by quantity when asked", async () => {
    const { ctx, purchaseOrderId, itemA, itemB } = await orderedTwoLines("QUANTITY");

    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [
        { purchaseOrderItemId: itemA.id, acceptedQty: toQty(10) },
        { purchaseOrderItemId: itemB.id, acceptedQty: toQty(10) },
      ],
    });

    const a = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemA.id } });
    const b = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemB.id } });
    expect(a.allocatedAdditionalCost).toBe(toMinor(200));
    expect(b.allocatedAdditionalCost).toBe(toMinor(200));
  });

  it("marks the order partially received and only absorbs the received share of costs", async () => {
    const { ctx, purchaseOrderId, itemA, itemB, productA } = await orderedTwoLines("VALUE");

    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: itemA.id, acceptedQty: toQty(5) }],
    });

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(po.receivingStatus).toBe("PARTIAL");

    // Line A's whole-order VALUE share of the 400 shipping is 100.00
    // (1000/4000); receiving 5 of its 10 units capitalises half of that:
    // 5 x 100 = 500 goods + 50 shipping => 110.00 per unit
    const balanceA = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: productA.id },
    });
    expect(balanceA.avgCost).toBe(toCost(toMinor(110)));
    expect(itemB).toBeDefined();
  });

  it("marks the order fully received when every line is complete", async () => {
    const { ctx, purchaseOrderId, itemA, itemB } = await orderedTwoLines();

    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [
        { purchaseOrderItemId: itemA.id, acceptedQty: toQty(10) },
        { purchaseOrderItemId: itemB.id, acceptedQty: toQty(10) },
      ],
    });

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(po.receivingStatus).toBe("RECEIVED");
  });

  it("puts damaged units in the damaged bucket at the same landed cost", async () => {
    const { ctx, purchaseOrderId, itemA, productA } = await orderedTwoLines();

    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: itemA.id, acceptedQty: toQty(8), damagedQty: toQty(2) }],
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: productA.id },
    });
    expect(balance.availableQty).toBe(toQty(8));
    expect(balance.damagedQty).toBe(toQty(2));
  });

  it("credits the supplier with the goods value received", async () => {
    const { company, ctx, purchaseOrderId, itemA, supplier } = await orderedTwoLines();

    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: itemA.id, acceptedQty: toQty(10) }],
    });

    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(toMinor(1000));
  });

  it("refuses to receive more than was ordered", async () => {
    const { ctx, purchaseOrderId, itemA } = await orderedTwoLines();

    await expect(
      receivePurchase(ctx, {
        purchaseOrderId,
        lines: [{ purchaseOrderItemId: itemA.id, acceptedQty: toQty(11) }],
      }),
    ).rejects.toMatchObject({ code: "RECEIVED_EXCEEDS_ORDERED" });
  });

  it("rejects duplicate lines for the same order item", async () => {
    const { ctx, purchaseOrderId, itemA } = await orderedTwoLines();
    await expect(receivePurchase(ctx, { purchaseOrderId, lines: [
      { purchaseOrderItemId: itemA.id, acceptedQty: toQty(6) },
      { purchaseOrderItemId: itemA.id, acceptedQty: toQty(6) },
    ] })).rejects.toMatchObject({ code: "DUPLICATE_RECEIPT_LINE" });
  });

  it("rejects a negative accepted quantity without touching the order", async () => {
    const { ctx, company, supplier, purchaseOrderId, itemA } = await orderedTwoLines();

    await expect(
      receivePurchase(ctx, {
        purchaseOrderId,
        lines: [{ purchaseOrderItemId: itemA.id, acceptedQty: toQty(-5) }],
      }),
    ).rejects.toMatchObject({ code: "QUANTITY_MUST_BE_NON_NEGATIVE" });

    expect(await supplierBalance(prisma, company.id, supplier.id)).toBe(0);
    expect(await prisma.purchaseReceipt.count()).toBe(0);
    const item = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemA.id } });
    expect(item.receivedQty).toBe(0);
  });

  it("telescopes gross, discount, and tax slices exactly across partial receipts", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    // orderedQty 3, unitPrice 100.00, discount 100.00 => lineTotal 200.00;
    // 15% tax => taxAmount 30.00; no additional costs => grandTotal 230.00.
    const { purchaseOrderId, grandTotal } = await createPurchaseOrder(ctx, {
      supplierId: supplier.id, warehouseId: warehouse.id,
      items: [{
        productId: productA.id, orderedQty: toQty(3),
        unitPrice: toMinor(100), discountAmount: toMinor(100), taxRatePct: 1500,
      }],
    });
    await confirmPurchaseOrder(ctx, purchaseOrderId);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow();
    expect(item.lineTotal).toBe(toMinor(200));
    expect(grandTotal).toBe(toMinor(230));

    // Three receipts of 1 unit each. Per the telescoping derivation:
    // gross slices 100.00/100.00/100.00, discount slices 33.33/33.34/33.33,
    // base-cost slices 66.67/66.66/66.67 (sum 200.00), tax slices
    // 10.00/10.00/10.00 (sum 30.00).
    for (let i = 0; i < 3; i++) {
      await receivePurchase(ctx, {
        purchaseOrderId,
        lines: [{ purchaseOrderItemId: item.id, acceptedQty: toQty(1) }],
      });
    }

    expect(await supplierBalance(prisma, ctx.companyId, supplier.id)).toBe(grandTotal);

    const receiptItems = await prisma.purchaseReceiptItem.findMany({
      where: { purchaseOrderItemId: item.id },
    });
    const totalLanded = receiptItems.reduce(
      (sum, r) => sum + costOf(r.acceptedQty + r.damagedQty, r.landedUnitCost),
      0,
    );
    expect(totalLanded).toBe(toMinor(200)); // lineTotal + additional-cost share (0)
  });

  it("credits the supplier for goods value plus tax, excluding additional costs", async () => {
    const { warehouse, supplier, productA, ctx } = await setup();
    // gross 1000.00 - discount 200.00 => subtotal (already discount-net) 800.00;
    // 10% tax on 800.00 => taxTotal 80.00; additionalCostTotal 50.00 =>
    // grandTotal 930.00. Expected supplier credit is subtotal + tax (additional
    // costs are not a supplier payable), i.e. 880.00 = grandTotal - additionalCostTotal.
    const { purchaseOrderId, grandTotal } = await createPurchaseOrder(ctx, {
      supplierId: supplier.id, warehouseId: warehouse.id,
      items: [{
        productId: productA.id, orderedQty: toQty(10),
        unitPrice: toMinor(100), discountAmount: toMinor(200), taxRatePct: 1000,
      }],
      additionalCosts: [{ costType: "CUSTOMS", amount: toMinor(50) }],
    });
    await confirmPurchaseOrder(ctx, purchaseOrderId);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow();
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });

    await receivePurchase(ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: item.id, acceptedQty: toQty(10) }],
    });

    // subtotal is already discount-net (lineTotal = gross - discount), so
    // adding discountTotal back on top of it would double-subtract.
    const expectedCredit = po.subtotal + po.taxTotal;
    expect(expectedCredit).toBe(toMinor(880));
    expect(expectedCredit).toBe(grandTotal - po.additionalCostTotal);
    expect(await supplierBalance(prisma, ctx.companyId, supplier.id)).toBe(expectedCredit);
  });

  it("never capitalises more additional cost than was incurred across receipts", async () => {
    const { ctx, purchaseOrderId, itemA, itemB } = await orderedTwoLines("VALUE");
    await receivePurchase(ctx, { purchaseOrderId, lines: [{ purchaseOrderItemId: itemA.id, acceptedQty: toQty(10) }] });
    await receivePurchase(ctx, { purchaseOrderId, lines: [{ purchaseOrderItemId: itemB.id, acceptedQty: toQty(10) }] });
    const items = await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId } });
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(items.reduce((s, i) => s + i.allocatedAdditionalCost, 0)).toBe(po.additionalCostTotal);
  });

  it("refuses to receive a draft order", async () => {
    const s = await setup();
    const { purchaseOrderId } = await createPurchaseOrder(s.ctx, {
      supplierId: s.supplier.id, warehouseId: s.warehouse.id,
      items: [{ productId: s.productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
    });
    const item = await prisma.purchaseOrderItem.findFirstOrThrow();

    await expect(
      receivePurchase(s.ctx, {
        purchaseOrderId,
        lines: [{ purchaseOrderItemId: item.id, acceptedQty: toQty(1) }],
      }),
    ).rejects.toMatchObject({ code: "PURCHASE_ORDER_NOT_CONFIRMED" });
  });
});

describe("cancelPurchaseOrder", () => {
  beforeEach(resetDb);

  it("cancels an order that has not been received", async () => {
    const s = await setup();
    const { purchaseOrderId } = await createPurchaseOrder(s.ctx, {
      supplierId: s.supplier.id, warehouseId: s.warehouse.id,
      items: [{ productId: s.productA.id, orderedQty: toQty(1), unitPrice: toMinor(10) }],
    });

    await cancelPurchaseOrder(s.ctx, purchaseOrderId, "Supplier out of stock");

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(po.status).toBe("CANCELLED");
  });

  it("refuses to cancel once stock has been received", async () => {
    const s = await setup();
    const { purchaseOrderId } = await createPurchaseOrder(s.ctx, {
      supplierId: s.supplier.id, warehouseId: s.warehouse.id,
      items: [{ productId: s.productA.id, orderedQty: toQty(2), unitPrice: toMinor(10) }],
    });
    await confirmPurchaseOrder(s.ctx, purchaseOrderId);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow();
    await receivePurchase(s.ctx, {
      purchaseOrderId,
      lines: [{ purchaseOrderItemId: item.id, acceptedQty: toQty(1) }],
    });

    await expect(
      cancelPurchaseOrder(s.ctx, purchaseOrderId, "changed my mind"),
    ).rejects.toMatchObject({ code: "PURCHASE_ALREADY_RECEIVED" });
  });
});

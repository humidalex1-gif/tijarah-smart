import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { ORDER_COST_TYPES, type OrderCostType, type ReturnCondition } from "@/lib/constants";
import { allocate, applyPct, QTY_SCALE, costOf } from "@/lib/money";
import { applyMovement } from "@/services/inventory";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";
import { appendCustomerLedger } from "@/services/ledger";
import { ServiceError, invalidState } from "@/services/errors";
import { adjustAccount } from "@/services/accounts-balance";

/** Which item column each order-level cost type lands in. */
const COST_COLUMN: Record<OrderCostType, string> = {
  SHIPPING: "allocatedShipping",
  PLATFORM_FEE: "allocatedPlatformFee",
  PAYMENT_FEE: "allocatedPaymentFee",
  COMMISSION: "allocatedCommission",
  OTHER: "allocatedOtherCost",
};

export async function createSalesOrder(
  ctx: ServiceContext,
  input: {
    customerId?: string | null;
    warehouseId: string;
    channel?: string;
    orderDate?: Date;
    shippingCharged?: number;
    notes?: string;
    items: {
      productId: string; variantId?: string | null;
      quantity: number; unitPrice: number;
      discountAmount?: number; taxRatePct?: number;
    }[];
    costs?: { costType: OrderCostType; description?: string; amount: number }[];
  },
) {
  if (input.items.length === 0) throw new ServiceError("NO_LINES");
  for (const item of input.items) {
    if (item.quantity <= 0) {
      throw invalidState("QUANTITY_MUST_BE_POSITIVE", { productId: item.productId });
    }
    if (item.unitPrice < 0) {
      throw invalidState("INVALID_PRICE", { productId: item.productId });
    }
    const gross = Math.round((item.quantity * item.unitPrice) / QTY_SCALE);
    const discountAmount = item.discountAmount ?? 0;
    if (discountAmount < 0 || discountAmount > gross) {
      throw invalidState("INVALID_DISCOUNT", { productId: item.productId });
    }
    if (item.taxRatePct !== undefined && item.taxRatePct < 0) {
      throw invalidState("INVALID_TAX_RATE", { productId: item.productId });
    }
  }
  for (const cost of input.costs ?? []) {
    if (!(ORDER_COST_TYPES as readonly string[]).includes(cost.costType)) {
      throw invalidState("INVALID_COST_TYPE", { costType: cost.costType });
    }
    if (cost.amount < 0) {
      throw invalidState("INVALID_COST_AMOUNT", { costType: cost.costType });
    }
  }
  if (input.shippingCharged !== undefined && input.shippingCharged < 0) {
    throw invalidState("INVALID_SHIPPING");
  }

  return prisma.$transaction(async (tx) => {
    await tx.warehouse.findFirstOrThrow({
      where: { id: input.warehouseId, companyId: ctx.companyId },
    });
    if (input.customerId) {
      await tx.customer.findFirstOrThrow({
        where: { id: input.customerId, companyId: ctx.companyId },
      });
    }

    const salesOrderNumber = await nextNumber(tx, ctx.companyId, "SO");

    const lines = input.items.map((item) => {
      const gross = Math.round((item.quantity * item.unitPrice) / QTY_SCALE);
      const lineTotal = gross - (item.discountAmount ?? 0);
      const taxAmount = applyPct(lineTotal, item.taxRatePct ?? 0);
      return { ...item, lineTotal, taxAmount };
    });

    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discountTotal = input.items.reduce((s, i) => s + (i.discountAmount ?? 0), 0);
    const taxTotal = lines.reduce((s, l) => s + l.taxAmount, 0);
    const shippingCharged = input.shippingCharged ?? 0;
    const grandTotal = subtotal + taxTotal + shippingCharged;

    const order = await tx.salesOrder.create({
      data: {
        companyId: ctx.companyId,
        salesOrderNumber,
        customerId: input.customerId ?? null,
        warehouseId: input.warehouseId,
        channel: input.channel ?? "STORE",
        orderDate: input.orderDate ?? new Date(),
        subtotal,
        discountTotal,
        taxTotal,
        shippingCharged,
        grandTotal,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    for (const line of lines) {
      await tx.salesOrderItem.create({
        data: {
          salesOrderId: order.id,
          productId: line.productId,
          variantId: line.variantId ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount ?? 0,
          taxAmount: line.taxAmount,
          lineTotal: line.lineTotal,
        },
      });
    }

    for (const cost of input.costs ?? []) {
      await tx.salesOrderCost.create({
        data: {
          salesOrderId: order.id,
          costType: cost.costType,
          description: cost.description ?? null,
          amount: cost.amount,
        },
      });
    }

    await writeAudit(tx, ctx, {
      action: "SALES_ORDER_CREATED",
      entityType: "SalesOrder",
      entityId: order.id,
      newValues: { salesOrderNumber, grandTotal },
    });

    return { salesOrderId: order.id, salesOrderNumber, grandTotal };
  });
}

/**
 * The full sale posting. Everything below happens in one transaction, so a
 * stock shortfall on the last line rolls back the whole confirmation.
 */
export async function confirmSale(
  ctx: ServiceContext,
  input: { salesOrderId: string; paidAmount?: number; accountId?: string },
) {
  const paidAmount = input.paidAmount ?? 0;
  if (paidAmount < 0) throw invalidState("INVALID_PAYMENT_AMOUNT");
  if (paidAmount > 0 && !input.accountId) throw new ServiceError("ACCOUNT_REQUIRED");

  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirstOrThrow({
      where: { id: input.salesOrderId, companyId: ctx.companyId },
      include: {
        items: { orderBy: { id: "asc" }, include: { components: true } },
        costs: true,
      },
    });
    if (order.status !== "DRAFT") throw new ServiceError("SALES_ORDER_NOT_DRAFT");
    if (paidAmount > order.grandTotal) throw invalidState("PAYMENT_EXCEEDS_TOTAL");

    // Tenant-check the account before touching stock, so a bad account id
    // fails fast rather than after posting movements that just get rolled back.
    const account = input.accountId
      ? await tx.financialAccount.findFirstOrThrow({
          where: { id: input.accountId, companyId: ctx.companyId },
        })
      : null;

    // 1. Stock out + cost snapshot per line.
    //
    // A bundle owns no shelf (Product.isBundle): its line expands into the
    // stored recipe and the COMPONENTS move, priced together as the line's
    // cost basis. Without this every bundle sale threw INSUFFICIENT_STOCK
    // against the bundle's nonexistent balance — the flagship products were
    // unsellable in the system. Customer-configured bundles have no stored
    // recipe on purpose (the picked components live on the order at the
    // warehouse, and will arrive with the Fast Hub order sync); until then
    // they fail loudly with BUNDLE_RECIPE_MISSING, which is the truth.
    const bundleIds = new Set(
      (await tx.product.findMany({
        where: {
          companyId: ctx.companyId,
          id: { in: order.items.map((i) => i.productId) },
          isBundle: true,
        },
        select: { id: true },
      })).map((p) => p.id),
    );
    const recipes = bundleIds.size === 0 ? [] : await tx.bundleComponent.findMany({
      where: { companyId: ctx.companyId, bundleProductId: { in: [...bundleIds] } },
      orderBy: { componentProductId: "asc" },
    });
    const recipeBy = new Map<string, typeof recipes>();
    for (const row of recipes) {
      const list = recipeBy.get(row.bundleProductId) ?? [];
      list.push(row);
      recipeBy.set(row.bundleProductId, list);
    }

    const priced = [];
    for (const item of order.items) {
      const movementBase = {
        warehouseId: order.warehouseId,
        movementType: "SALE" as const,
        direction: "OUT" as const,
        referenceType: "SALES_ORDER",
        referenceId: order.id,
        referenceNumber: order.salesOrderNumber,
      };

      // What the warehouse ACTUALLY picked beats any stored recipe: four of
      // the five bundles are customer-configured, so only the order knows
      // which colours left the shelf. Picked quantities are absolute (they
      // describe this order), unlike recipe quantities which are per bundle.
      const picked = item.components ?? [];
      if (picked.length > 0) {
        let totalCost = 0;
        for (const component of picked) {
          const out = await applyMovement(tx, ctx, {
            ...movementBase,
            productId: component.componentProductId,
            variantId: null,
            quantity: component.quantity,
          });
          totalCost += out.totalCost;
        }
        priced.push({
          item,
          unitCostSnapshot: Math.round((totalCost * 10_000_000) / item.quantity),
          totalCost,
          grossProfit: item.lineTotal - totalCost,
        });
        continue;
      }

      if (bundleIds.has(item.productId)) {
        const recipe = recipeBy.get(item.productId) ?? [];
        if (recipe.length === 0) {
          throw invalidState("BUNDLE_RECIPE_MISSING", { productId: item.productId });
        }
        let totalCost = 0;
        for (const component of recipe) {
          const out = await applyMovement(tx, ctx, {
            ...movementBase,
            productId: component.componentProductId,
            variantId: null,
            // Both quantities are thousandths; the product carries the scale
            // twice, so it comes back down once (same as expandSaleLines).
            quantity: (item.quantity * component.quantity) / 1000,
          });
          totalCost += out.totalCost;
        }
        priced.push({
          item,
          // Per bundle unit, back at cost scale: minor x 10^4 per unit, where
          // units = quantity / 10^3.
          unitCostSnapshot: Math.round((totalCost * 10_000_000) / item.quantity),
          totalCost,
          grossProfit: item.lineTotal - totalCost,
        });
        continue;
      }

      const out = await applyMovement(tx, ctx, {
        ...movementBase,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      });
      priced.push({
        item,
        unitCostSnapshot: out.unitCost,
        totalCost: out.totalCost,
        grossProfit: item.lineTotal - out.totalCost,
      });
    }

    // 2. Allocate order-level costs across lines by revenue share.
    const weights = priced.map((p) => p.item.lineTotal);
    const allocatedByColumn: Record<string, number[]> = {};
    for (const cost of order.costs) {
      const column = COST_COLUMN[cost.costType as OrderCostType] ?? "allocatedOtherCost";
      const parts = allocate(cost.amount, weights);
      allocatedByColumn[column] = (allocatedByColumn[column] ?? priced.map(() => 0))
        .map((existing, i) => existing + parts[i]);
    }

    // 3. Write per-item profit figures.
    let grossProfit = 0;
    let netProfit = 0;
    let totalCost = 0;

    for (let i = 0; i < priced.length; i++) {
      const p = priced[i];
      const allocatedShipping = allocatedByColumn.allocatedShipping?.[i] ?? 0;
      const allocatedPlatformFee = allocatedByColumn.allocatedPlatformFee?.[i] ?? 0;
      const allocatedPaymentFee = allocatedByColumn.allocatedPaymentFee?.[i] ?? 0;
      const allocatedCommission = allocatedByColumn.allocatedCommission?.[i] ?? 0;
      const allocatedOtherCost = allocatedByColumn.allocatedOtherCost?.[i] ?? 0;

      const itemNet = p.grossProfit
        - allocatedShipping - allocatedPlatformFee
        - allocatedPaymentFee - allocatedCommission - allocatedOtherCost;

      await tx.salesOrderItem.update({
        where: { id: p.item.id },
        data: {
          unitCostSnapshot: p.unitCostSnapshot,
          totalCost: p.totalCost,
          grossProfit: p.grossProfit,
          allocatedShipping,
          allocatedPlatformFee,
          allocatedPaymentFee,
          allocatedCommission,
          allocatedOtherCost,
          netProfit: itemNet,
        },
      });

      grossProfit += p.grossProfit;
      netProfit += itemNet;
      totalCost += p.totalCost;
    }

    // Shipping charged to the customer is revenue that belongs to the order,
    // not to any single line.
    netProfit += order.shippingCharged;

    // 4. Customer receivable.
    if (order.customerId) {
      await appendCustomerLedger(tx, ctx, {
        customerId: order.customerId,
        transactionType: "SALE",
        referenceType: "SALES_ORDER",
        referenceId: order.id,
        referenceNumber: order.salesOrderNumber,
        debitAmount: order.grandTotal,
      });
    }

    // 5. Payment, if any.
    let paymentNumber: string | null = null;
    if (paidAmount > 0) {
      if (!account) throw invalidState("ACCOUNT_REQUIRED");

      paymentNumber = await nextNumber(tx, ctx.companyId, "PAY");
      const payment = await tx.payment.create({
        data: {
          companyId: ctx.companyId,
          paymentNumber,
          paymentType: "CUSTOMER_PAYMENT",
          customerId: order.customerId,
          salesOrderId: order.id,
          accountId: account.id,
          amount: paidAmount,
          createdById: ctx.userId,
        },
      });

      await adjustAccount(tx, ctx.companyId, account.id, paidAmount);

      if (order.customerId) {
        await appendCustomerLedger(tx, ctx, {
          customerId: order.customerId,
          transactionType: "PAYMENT",
          referenceType: "PAYMENT",
          referenceId: payment.id,
          referenceNumber: paymentNumber,
          creditAmount: paidAmount,
        });
      }
    }

    const paymentStatus =
      paidAmount >= order.grandTotal ? "PAID" : paidAmount > 0 ? "PARTIAL" : "UNPAID";

    await tx.salesOrder.update({
      where: { id: order.id },
      data: {
        status: "CONFIRMED",
        paymentStatus,
        paidAmount,
        totalCost,
        grossProfit,
        netProfit,
      },
    });

    await writeAudit(tx, ctx, {
      action: "SALE_CONFIRMED",
      entityType: "SalesOrder",
      entityId: order.id,
      newValues: {
        salesOrderNumber: order.salesOrderNumber,
        grandTotal: order.grandTotal,
        grossProfit, netProfit, paidAmount,
      },
    });

    return { grossProfit, netProfit };
  });
}

/**
 * Reverse a confirmed sale. Nothing is deleted: the original movements,
 * ledger entries, and payments stay on the record and are offset by
 * matching reversal entries.
 */
export async function cancelSale(
  ctx: ServiceContext,
  input: { salesOrderId: string; reason: string },
) {
  if (!input.reason || input.reason.trim() === "") throw new ServiceError("REASON_REQUIRED");

  await prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirstOrThrow({
      where: { id: input.salesOrderId, companyId: ctx.companyId },
      include: { items: true, payments: true },
    });
    if (order.status !== "CONFIRMED") throw new ServiceError("SALES_ORDER_NOT_CONFIRMED");

    // confirmSale moved a bundle's COMPONENTS out, so reversing by the line
    // product would mint stock for a product that owns no shelf while the
    // components stay deducted. Same refusal, same reason, as processReturn's
    // BUNDLE_RETURN_UNSUPPORTED — loud beats silently corrupting the shelf.
    const cancelledBundle = await tx.product.findFirst({
      where: {
        companyId: ctx.companyId,
        id: { in: order.items.map((i) => i.productId) },
        isBundle: true,
      },
      select: { id: true },
    });
    if (cancelledBundle) {
      throw invalidState("BUNDLE_CANCEL_UNSUPPORTED", { productId: cancelledBundle.id });
    }

    // 1. Put every unit that actually left back at the cost it left with.
    for (const item of order.items) {
      const outstanding = item.quantity - item.returnedQty;
      if (outstanding <= 0) continue;

      await applyMovement(tx, ctx, {
        warehouseId: order.warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        movementType: "CANCELLATION_REVERSAL",
        direction: "IN",
        quantity: outstanding,
        unitCost: item.unitCostSnapshot,
        referenceType: "SALES_ORDER_CANCELLATION",
        referenceId: order.id,
        referenceNumber: order.salesOrderNumber,
        reason: input.reason,
      });
    }

    // 2. Undo the receivable.
    if (order.customerId) {
      await appendCustomerLedger(tx, ctx, {
        customerId: order.customerId,
        transactionType: "SALE_CANCELLED",
        referenceType: "SALES_ORDER",
        referenceId: order.id,
        referenceNumber: order.salesOrderNumber,
        creditAmount: order.grandTotal - order.refundedAmount,
      });
    }

    // 3. Hand back any money already collected — net of cash already refunded
    //    by a prior return, otherwise those units get paid out twice.
    const customerPaid = order.payments
      .filter((p) => p.paymentType === "CUSTOMER_PAYMENT" && p.status === "CONFIRMED")
      .reduce((sum, p) => sum + p.amount, 0);
    const alreadyRefunded = order.payments
      .filter((p) => p.paymentType === "REFUND" && p.status === "CONFIRMED")
      .reduce((sum, p) => sum + p.amount, 0);
    const collected = Math.max(0, customerPaid - alreadyRefunded);

    if (collected > 0) {
      const sourceAccountId = order.payments.find(
        (p) => p.paymentType === "CUSTOMER_PAYMENT" && p.status === "CONFIRMED",
      )!.accountId;

      const paymentNumber = await nextNumber(tx, ctx.companyId, "PAY");
      // Capture the created payment: the ledger entry below must reference the
      // Payment row, not the order (same convention as confirmSale post-review).
      const refundPayment = await tx.payment.create({
        data: {
          companyId: ctx.companyId,
          paymentNumber,
          paymentType: "REFUND",
          customerId: order.customerId,
          salesOrderId: order.id,
          accountId: sourceAccountId,
          amount: collected,
          notes: input.reason,
          createdById: ctx.userId,
        },
      });

      await adjustAccount(tx, ctx.companyId, sourceAccountId, -collected);

      if (order.customerId) {
        await appendCustomerLedger(tx, ctx, {
          customerId: order.customerId,
          transactionType: "REFUND",
          referenceType: "PAYMENT",
          referenceId: refundPayment.id,
          referenceNumber: paymentNumber,
          debitAmount: collected,
        });
      }
    }

    // 4. A cancelled order contributes nothing to profit. Note paymentStatus
    // is deliberately NOT touched here: it stays whatever it was (e.g. PAID)
    // even though the order is now CANCELLED, because PaymentStatus has no
    // REFUNDED value to move it to. Any code that reads paymentStatus for
    // reporting or receivables MUST filter out CANCELLED orders first rather
    // than trust paymentStatus alone — see docs/decisions.md.
    await tx.salesOrder.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        grossProfit: 0,
        netProfit: 0,
        totalCost: 0,
        refundedAmount: order.refundedAmount + collected,
        // Preserve the original notes (same convention as cancelPurchaseOrder
        // post-review): the reason is also in the audit row.
        notes: order.notes ? `${order.notes} | CANCELLED: ${input.reason}` : input.reason,
      },
    });

    await writeAudit(tx, ctx, {
      action: "SALE_CANCELLED",
      entityType: "SalesOrder",
      entityId: order.id,
      oldValues: { status: "CONFIRMED", netProfit: order.netProfit },
      newValues: { status: "CANCELLED", reason: input.reason, refunded: collected },
    });
  });
}

export async function processReturn(
  ctx: ServiceContext,
  input: {
    salesOrderId: string;
    reason?: string;
    refundAccountId?: string;
    items: {
      salesOrderItemId: string;
      quantity: number;
      condition: ReturnCondition;
      warehouseId?: string;
      refundAmount: number;
    }[];
  },
) {
  if (input.items.length === 0) throw new ServiceError("NO_LINES");
  // Two lines for the same item would each validate against the same stale
  // returnedQty snapshot, bypassing the per-item cap -- and both the stock
  // movement and the refund would actually happen twice.
  const seenItems = new Set<string>();
  for (const line of input.items) {
    if (seenItems.has(line.salesOrderItemId)) {
      throw new ServiceError("DUPLICATE_RETURN_LINE", { salesOrderItemId: line.salesOrderItemId });
    }
    seenItems.add(line.salesOrderItemId);
  }
  for (const line of input.items) {
    if (line.quantity <= 0) {
      throw invalidState("QUANTITY_MUST_BE_POSITIVE", { salesOrderItemId: line.salesOrderItemId });
    }
    if (line.refundAmount < 0) {
      throw invalidState("INVALID_REFUND_AMOUNT", { salesOrderItemId: line.salesOrderItemId });
    }
  }

  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirstOrThrow({
      where: { id: input.salesOrderId, companyId: ctx.companyId },
      include: { items: true },
    });
    if (order.status !== "CONFIRMED") throw new ServiceError("SALES_ORDER_NOT_CONFIRMED");

    // Validate every line against the item's outstanding quantity before any
    // writes happen, so a bad line in a multi-line return doesn't leave a
    // partial return applied.
    for (const line of input.items) {
      const item = order.items.find((i) => i.id === line.salesOrderItemId);
      if (!item) throw invalidState("SALES_ITEM_NOT_FOUND", { id: line.salesOrderItemId });
      if (item.returnedQty + line.quantity > item.quantity) {
        throw new ServiceError("RETURN_EXCEEDS_SOLD", {
          itemId: item.id, sold: item.quantity,
          alreadyReturned: item.returnedQty, requested: line.quantity,
        });
      }
    }

    // A returned bundle cannot be restocked as "one bundle": it has no shelf,
    // and posting the IN leg would mint a balance for a product that never
    // holds stock — phantom units the next reconciliation would chase. WHICH
    // physical components came back, and in what condition, is decided by the
    // warehouse's QC on the return — record those as component-level facts
    // (the Fast Hub returns flow) rather than guessing here.
    const returnedProductIds = input.items.map((line) =>
      order.items.find((i) => i.id === line.salesOrderItemId)!.productId,
    );
    const returnedBundle = await tx.product.findFirst({
      where: { companyId: ctx.companyId, id: { in: returnedProductIds }, isBundle: true },
      select: { id: true },
    });
    if (returnedBundle) {
      throw invalidState("BUNDLE_RETURN_UNSUPPORTED", { productId: returnedBundle.id });
    }

    const refundAmount = input.items.reduce((s, i) => s + i.refundAmount, 0);

    // A refund with nowhere to land would silently vanish: recorded as
    // refunded, but no cash and no ledger credit ever actually moves.
    if (refundAmount > 0 && !input.refundAccountId && !order.customerId) {
      throw invalidState("REFUND_DESTINATION_REQUIRED");
    }
    // Bound this call's refund by what's left of the order's value, so
    // refundedAmount never exceeds grandTotal -- the anchor cancelSale nets
    // against when crediting back collected cash.
    if (order.refundedAmount + refundAmount > order.grandTotal) {
      throw invalidState("REFUND_EXCEEDS_ORDER");
    }

    const returnNumber = await nextNumber(tx, ctx.companyId, "RET");

    const customerReturn = await tx.customerReturn.create({
      data: {
        companyId: ctx.companyId,
        salesOrderId: order.id,
        customerId: order.customerId,
        returnNumber,
        refundAmount,
        reason: input.reason ?? null,
        createdById: ctx.userId,
      },
    });

    let costReversalTotal = 0;

    for (const line of input.items) {
      // Existence and the per-item cap were already validated above.
      const item = order.items.find((i) => i.id === line.salesOrderItemId)!;

      const warehouseId = line.warehouseId ?? order.warehouseId;
      const costReversal = costOf(line.quantity, item.unitCostSnapshot);
      costReversalTotal += costReversal;

      await applyMovement(tx, ctx, {
        warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        movementType: "CUSTOMER_RETURN",
        direction: "IN",
        bucket: line.condition === "DAMAGED" ? "DAMAGED" : "AVAILABLE",
        quantity: line.quantity,
        unitCost: item.unitCostSnapshot,
        referenceType: "CUSTOMER_RETURN",
        referenceId: customerReturn.id,
        referenceNumber: returnNumber,
        reason: input.reason ?? line.condition,
      });

      await tx.customerReturnItem.create({
        data: {
          returnId: customerReturn.id,
          salesOrderItemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: line.quantity,
          condition: line.condition,
          warehouseId,
          refundAmount: line.refundAmount,
          costReversal,
        },
      });

      await tx.salesOrderItem.update({
        where: { id: item.id },
        data: {
          returnedQty: item.returnedQty + line.quantity,
          returnedRevenue: item.returnedRevenue + line.refundAmount,
          returnedCost: item.returnedCost + costReversal,
        },
      });
    }

    await tx.customerReturn.update({
      where: { id: customerReturn.id },
      data: { costReversal: costReversalTotal },
    });

    // Refund: either cash out of an account, or credit against what they owe.
    // Gated on the AMOUNT, not merely the presence of refundAccountId — an
    // exchange/restock return with a zero refund has no money to move, so it
    // must write no Payment row and no ledger row at all, regardless of
    // whether a caller happened to pass an account. (The create-sale form's
    // own client-side guard mirrors this — see ReturnForm.tsx — but the
    // service is the actual source of truth and must not depend on it.)
    if (input.refundAccountId && refundAmount > 0) {
      const paymentNumber = await nextNumber(tx, ctx.companyId, "PAY");
      // Capture the created payment: the REFUND ledger leg below must
      // reference the Payment row, not the order (same convention as
      // cancelSale's refund).
      const refundPayment = await tx.payment.create({
        data: {
          companyId: ctx.companyId,
          paymentNumber,
          paymentType: "REFUND",
          customerId: order.customerId,
          salesOrderId: order.id,
          accountId: input.refundAccountId,
          amount: refundAmount,
          notes: input.reason ?? "Customer return",
          createdById: ctx.userId,
        },
      });

      await adjustAccount(tx, ctx.companyId, input.refundAccountId, -refundAmount);

      // A cash refund still moves money that the return also affects on the
      // customer statement (spec §7): credit RETURN (what the return reduces
      // what they owe by) then debit REFUND (the cash paid back out) so both
      // legs are visible even though they net to zero. Walk-in refunds (no
      // customerId) have no statement to write to.
      if (order.customerId) {
        await appendCustomerLedger(tx, ctx, {
          customerId: order.customerId,
          transactionType: "RETURN",
          referenceType: "CUSTOMER_RETURN",
          referenceId: customerReturn.id,
          referenceNumber: returnNumber,
          creditAmount: refundAmount,
        });
        await appendCustomerLedger(tx, ctx, {
          customerId: order.customerId,
          transactionType: "REFUND",
          referenceType: "PAYMENT",
          referenceId: refundPayment.id,
          referenceNumber: paymentNumber,
          debitAmount: refundAmount,
        });
      }
    } else if (order.customerId && refundAmount > 0) {
      await appendCustomerLedger(tx, ctx, {
        customerId: order.customerId,
        transactionType: "RETURN",
        referenceType: "CUSTOMER_RETURN",
        referenceId: customerReturn.id,
        referenceNumber: returnNumber,
        creditAmount: refundAmount,
      });
    }

    // Recompute the order's profit from the surviving (unreturned) portions.
    const items = await tx.salesOrderItem.findMany({ where: { salesOrderId: order.id } });
    let grossProfit = 0;
    let netProfit = 0;
    let totalCost = 0;

    for (const item of items) {
      const netRevenue = item.lineTotal - item.returnedRevenue;
      const netCost = item.totalCost - item.returnedCost;
      const allocated = item.allocatedShipping + item.allocatedPlatformFee
        + item.allocatedPaymentFee + item.allocatedCommission + item.allocatedOtherCost;

      grossProfit += netRevenue - netCost;
      netProfit += netRevenue - netCost - allocated;
      totalCost += netCost;
    }
    netProfit += order.shippingCharged;

    await tx.salesOrder.update({
      where: { id: order.id },
      data: {
        grossProfit, netProfit, totalCost,
        refundedAmount: order.refundedAmount + refundAmount,
      },
    });

    await writeAudit(tx, ctx, {
      action: "CUSTOMER_RETURN_PROCESSED",
      entityType: "CustomerReturn",
      entityId: customerReturn.id,
      newValues: { returnNumber, refundAmount, costReversalTotal },
    });

    return { returnId: customerReturn.id, returnNumber, refundAmount };
  });
}

/**
 * Re-allocates an order's costs and rewrites its profit figures.
 *
 * `confirmSale` reads `SalesOrderCost` exactly once, at confirmation. That was
 * fine while every cost was known when the order was placed — and wrong the
 * moment the warehouse's monthly bill arrived, because a bill cannot precede
 * the orders it bills. Without this, fulfilment fees posted to a table nothing
 * read again and net profit kept reporting the figure it had at confirmation.
 *
 * It recomputes from the cost rows rather than subtracting from what is
 * already stored, so posting the same invoice twice cannot compound. Gross
 * profit, unit costs and stock are never touched: a fulfilment fee is not part
 * of the cost of the goods and must never come to look like it is.
 */
export async function recomputeOrderCostAllocation(
  ctx: ServiceContext,
  salesOrderId: string,
): Promise<{ netProfit: number }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findFirstOrThrow({
      where: { id: salesOrderId, companyId: ctx.companyId },
      include: {
        // Stable order: `allocate` hands its rounding remainder to specific
        // positions, so an unordered read would move a halala between lines
        // on every run and make this look non-idempotent.
        items: { orderBy: { id: "asc" } },
        costs: { orderBy: { id: "asc" } },
      },
    });
    if (order.status !== "CONFIRMED") throw new ServiceError("SALES_ORDER_NOT_CONFIRMED");

    const weights = order.items.map((item) => item.lineTotal);
    const allocatedByColumn: Record<string, number[]> = {};
    for (const cost of order.costs) {
      const column = COST_COLUMN[cost.costType as OrderCostType] ?? "allocatedOtherCost";
      const parts = allocate(cost.amount, weights);
      allocatedByColumn[column] = (allocatedByColumn[column] ?? order.items.map(() => 0))
        .map((existing, i) => existing + parts[i]);
    }

    let netProfit = 0;
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      const allocatedShipping = allocatedByColumn.allocatedShipping?.[i] ?? 0;
      const allocatedPlatformFee = allocatedByColumn.allocatedPlatformFee?.[i] ?? 0;
      const allocatedPaymentFee = allocatedByColumn.allocatedPaymentFee?.[i] ?? 0;
      const allocatedCommission = allocatedByColumn.allocatedCommission?.[i] ?? 0;
      const allocatedOtherCost = allocatedByColumn.allocatedOtherCost?.[i] ?? 0;

      // NET of any customer return, mirroring processReturn's own formula:
      // item.grossProfit is deliberately left GROSS by processReturn (the
      // return lives in returnedRevenue/returnedCost), so building on it raw
      // silently restored returned profit whenever a warehouse invoice was
      // posted after a return. (lineTotal − returnedRevenue) − (totalCost −
      // returnedCost) is the same basis processReturn writes to the order.
      const netGross = (item.lineTotal - item.returnedRevenue)
        - (item.totalCost - item.returnedCost);
      const itemNet = netGross
        - allocatedShipping - allocatedPlatformFee
        - allocatedPaymentFee - allocatedCommission - allocatedOtherCost;

      await tx.salesOrderItem.update({
        where: { id: item.id },
        data: {
          allocatedShipping, allocatedPlatformFee, allocatedPaymentFee,
          allocatedCommission, allocatedOtherCost, netProfit: itemNet,
        },
      });
      netProfit += itemNet;
    }

    // Same as confirmSale: shipping charged to the customer is the order's
    // revenue, not any single line's.
    netProfit += order.shippingCharged;

    await tx.salesOrder.update({ where: { id: order.id }, data: { netProfit } });
    return { netProfit };
  });
}

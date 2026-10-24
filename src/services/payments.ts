import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/services/context";
import { nextNumber } from "@/services/numbering";
import { writeAudit } from "@/services/audit";
import { appendCustomerLedger, appendSupplierLedger } from "@/services/ledger";
import { ServiceError, invalidState } from "@/services/errors";
import { adjustAccount } from "@/services/accounts-balance";

function statusFor(paid: number, total: number) {
  return paid >= total && total > 0 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";
}

export async function recordCustomerPayment(
  ctx: ServiceContext,
  input: {
    customerId: string; salesOrderId?: string; accountId: string;
    amount: number; paymentDate?: Date; referenceNumber?: string; notes?: string;
  },
) {
  if (input.amount <= 0) throw new ServiceError("AMOUNT_MUST_BE_POSITIVE");

  return prisma.$transaction(async (tx) => {
    await tx.customer.findFirstOrThrow({
      where: { id: input.customerId, companyId: ctx.companyId },
    });

    const order = input.salesOrderId
      ? await tx.salesOrder.findFirstOrThrow({
          where: { id: input.salesOrderId, customerId: input.customerId, companyId: ctx.companyId },
        })
      : null;
    if (order && order.status === "CANCELLED") {
      throw invalidState("ORDER_CANCELLED");
    }
    // A DRAFT order has no receivable yet — confirmSale is what posts it and
    // sets paidAmount from ITS OWN paidAmount argument, overwriting whatever
    // is already on the row. A payment recorded here against a still-DRAFT
    // order would post real money (Payment row, ledger credit, account
    // debit) and then have its own contribution to `order.paidAmount`
    // silently clobbered the moment the order is confirmed, stranding that
    // payment's ledger/cash legs with nothing on the order to show for them.
    // Only a CONFIRMED order may take a linked payment.
    if (order && order.status !== "CONFIRMED") {
      throw invalidState("ORDER_NOT_CONFIRMED");
    }
    if (order && order.paidAmount + input.amount > order.grandTotal) {
      throw invalidState("PAYMENT_EXCEEDS_TOTAL");
    }

    // Tenant-check (and apply) the account before writing the Payment row.
    await adjustAccount(tx, ctx.companyId, input.accountId, input.amount);

    const paymentNumber = await nextNumber(tx, ctx.companyId, "PAY");
    const payment = await tx.payment.create({
      data: {
        companyId: ctx.companyId,
        paymentNumber,
        paymentType: "CUSTOMER_PAYMENT",
        customerId: input.customerId,
        salesOrderId: input.salesOrderId ?? null,
        accountId: input.accountId,
        amount: input.amount,
        paymentDate: input.paymentDate ?? new Date(),
        referenceNumber: input.referenceNumber ?? null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    await appendCustomerLedger(tx, ctx, {
      customerId: input.customerId,
      transactionType: "PAYMENT",
      referenceType: "PAYMENT",
      referenceId: payment.id,
      referenceNumber: paymentNumber,
      creditAmount: input.amount,
    });

    if (order) {
      const paidAmount = order.paidAmount + input.amount;
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { paidAmount, paymentStatus: statusFor(paidAmount, order.grandTotal) },
      });
    }

    await writeAudit(tx, ctx, {
      action: "CUSTOMER_PAYMENT_RECORDED",
      entityType: "Payment",
      entityId: payment.id,
      newValues: { paymentNumber, amount: input.amount },
    });

    return { paymentId: payment.id, paymentNumber };
  });
}

export async function recordSupplierPayment(
  ctx: ServiceContext,
  input: {
    supplierId: string; purchaseOrderId?: string; accountId: string;
    amount: number; paymentDate?: Date; referenceNumber?: string; notes?: string;
  },
) {
  if (input.amount <= 0) throw new ServiceError("AMOUNT_MUST_BE_POSITIVE");

  return prisma.$transaction(async (tx) => {
    await tx.supplier.findFirstOrThrow({
      where: { id: input.supplierId, companyId: ctx.companyId },
    });

    const po = input.purchaseOrderId
      ? await tx.purchaseOrder.findFirstOrThrow({
          where: { id: input.purchaseOrderId, supplierId: input.supplierId, companyId: ctx.companyId },
        })
      : null;
    if (po && po.status === "CANCELLED") {
      throw invalidState("ORDER_CANCELLED");
    }
    // AP is credited at receive time for goods + tax only — additional costs
    // (freight, customs, handling) are deliberately not a supplier payable
    // (Task 8 design; see docs/decisions.md). Capping at grandTotal would let
    // a payment overpay the supplier's actual balance by additionalCostTotal.
    // Cap = goods + tax for the WHOLE order (exact once fully received).
    // AP is credited progressively per receipt, so a payment on a partially
    // received PO can legitimately run ahead of the current supplier balance
    // (an advance) — the cap bounds the total, not the instant.
    if (po && po.paidAmount + input.amount > po.grandTotal - po.additionalCostTotal) {
      throw invalidState("PAYMENT_EXCEEDS_TOTAL");
    }

    // Tenant-check (and apply) the account before writing the Payment row.
    await adjustAccount(tx, ctx.companyId, input.accountId, -input.amount);

    const paymentNumber = await nextNumber(tx, ctx.companyId, "PAY");
    const payment = await tx.payment.create({
      data: {
        companyId: ctx.companyId,
        paymentNumber,
        paymentType: "SUPPLIER_PAYMENT",
        supplierId: input.supplierId,
        purchaseOrderId: input.purchaseOrderId ?? null,
        accountId: input.accountId,
        amount: input.amount,
        paymentDate: input.paymentDate ?? new Date(),
        referenceNumber: input.referenceNumber ?? null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    await appendSupplierLedger(tx, ctx, {
      supplierId: input.supplierId,
      transactionType: "PAYMENT",
      referenceType: "PAYMENT",
      referenceId: payment.id,
      referenceNumber: paymentNumber,
      debitAmount: input.amount,
    });

    if (po) {
      const paidAmount = po.paidAmount + input.amount;
      // Status is measured against the same payable the cap above uses —
      // goods + tax, excluding additional costs. Measuring against
      // grandTotal would make PAID unreachable for any PO that carries
      // additional costs, since the cap forbids ever paying that much.
      const payable = po.grandTotal - po.additionalCostTotal;
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { paidAmount, paymentStatus: statusFor(paidAmount, payable) },
      });
    }

    await writeAudit(tx, ctx, {
      action: "SUPPLIER_PAYMENT_RECORDED",
      entityType: "Payment",
      entityId: payment.id,
      newValues: { paymentNumber, amount: input.amount },
    });

    return { paymentId: payment.id, paymentNumber };
  });
}

export async function transferBetweenAccounts(
  ctx: ServiceContext,
  input: { fromAccountId: string; toAccountId: string; amount: number; notes?: string },
) {
  if (input.amount <= 0) throw new ServiceError("AMOUNT_MUST_BE_POSITIVE");
  if (input.fromAccountId === input.toAccountId) throw invalidState("SAME_ACCOUNT");

  return prisma.$transaction(async (tx) => {
    // Tenant-check (and apply) both accounts before writing the Payment row.
    await adjustAccount(tx, ctx.companyId, input.fromAccountId, -input.amount);
    await adjustAccount(tx, ctx.companyId, input.toAccountId, input.amount);

    const paymentNumber = await nextNumber(tx, ctx.companyId, "PAY");
    const payment = await tx.payment.create({
      data: {
        companyId: ctx.companyId,
        paymentNumber,
        paymentType: "ACCOUNT_TRANSFER",
        accountId: input.fromAccountId,
        destinationAccountId: input.toAccountId,
        amount: input.amount,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
    });

    await writeAudit(tx, ctx, {
      action: "ACCOUNT_TRANSFER",
      entityType: "Payment",
      entityId: payment.id,
      newValues: { paymentNumber, amount: input.amount },
    });

    return { paymentId: payment.id, paymentNumber };
  });
}

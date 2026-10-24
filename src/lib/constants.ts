export const ROLES = [
  "OWNER", "ADMIN", "ACCOUNTANT", "WAREHOUSE_MANAGER", "SALES_EMPLOYEE", "VIEWER",
] as const;
export type Role = (typeof ROLES)[number];

export const MOVEMENT_TYPES = [
  "PURCHASE_RECEIPT", "SALE", "CUSTOMER_RETURN", "SUPPLIER_RETURN",
  "TRANSFER_OUT", "TRANSFER_IN", "ADJUSTMENT_IN", "ADJUSTMENT_OUT",
  "DAMAGED", "LOST", "INTERNAL_USE", "PROMOTIONAL_USE", "CANCELLATION_REVERSAL",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export type MovementDirection = "IN" | "OUT";

// DISPUTED holds units the merchant believes exist but the custodian has not
// confirmed — returns the fulfilment warehouse never counted, damage it never
// acknowledged. They are owned and carry their cost, but they are not sellable,
// so availableQty keeps meaning "sellable" and no sale path needs a second
// query. Unlike DAMAGED (a write-off with no cost basis, docs/decisions.md #7)
// a disputed unit keeps its value: it either comes back or becomes shrinkage,
// and both outcomes need the cost it was bought at.
export type StockBucket = "AVAILABLE" | "DAMAGED" | "DISPUTED";

export const ALLOCATION_METHODS = [
  "QUANTITY", "VALUE", "WEIGHT", "EQUAL", "MANUAL",
] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export type DocumentStatus = "DRAFT" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
export type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";
export type ReceivingStatus = "PENDING" | "PARTIAL" | "RECEIVED";
export type TransferStatus = "DRAFT" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
export type ProductType = "SIMPLE" | "VARIANT";
export const RETURN_CONDITIONS = ["SELLABLE", "DAMAGED"] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];
export type AccountType = "CASH" | "BANK";

export const CUSTOMER_TYPES = ["RETAIL", "WHOLESALE"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

// Freeform on the SalesOrder.channel column (no DB constraint) — these are
// the values the seed data and the create-sale form actually offer, not an
// exhaustive enum the service enforces.
export const SALES_CHANNELS = ["STORE", "WHATSAPP", "ONLINE", "WHOLESALE"] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const PAYMENT_TYPES = [
  "CUSTOMER_PAYMENT", "SUPPLIER_PAYMENT", "REFUND",
  "ACCOUNT_TRANSFER", "OWNER_CONTRIBUTION", "OWNER_WITHDRAWAL", "EXPENSE",
] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export type LedgerRefType =
  | "SALES_ORDER" | "PURCHASE_ORDER" | "PAYMENT" | "CUSTOMER_RETURN" | "SUPPLIER_RETURN";

export const ORDER_COST_TYPES = [
  "SHIPPING", "PLATFORM_FEE", "PAYMENT_FEE", "COMMISSION", "OTHER",
] as const;
export type OrderCostType = (typeof ORDER_COST_TYPES)[number];

export const PURCHASE_COST_TYPES = [
  "INTERNATIONAL_SHIPPING", "LOCAL_SHIPPING", "CUSTOMS", "INSURANCE",
  "HANDLING", "INSPECTION", "STORAGE", "OTHER",
] as const;
export type PurchaseCostType = (typeof PURCHASE_COST_TYPES)[number];

/** What a disagreement with the fulfilment warehouse is about. */
export const CLAIM_KINDS = ["RETURN", "DAMAGE", "SHORTAGE"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Append-only. Every row is an assertion by one party at one time. */
export const CLAIM_EVENT_TYPES = ["OPENED", "SETTLED", "CANCELLED"] as const;
export type ClaimEventType = (typeof CLAIM_EVENT_TYPES)[number];

// Who is asserting. The whole design turns on never losing this: the system
// records that Salla says one thing and the warehouse says another, and never
// silently picks a side.
export const ASSERTERS = ["MERCHANT", "SALLA", "WAREHOUSE"] as const;
export type Asserter = (typeof ASSERTERS)[number];

export const AD_CHANNELS = ["META", "GOOGLE", "TIKTOK", "SNAPCHAT", "OTHER"] as const;
export type AdChannel = (typeof AD_CHANNELS)[number];

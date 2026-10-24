import type { Role } from "@/lib/constants";
import { ServiceError } from "@/services/errors";

/**
 * Every permission string the app gates on, including the seven Tasks 5–9
 * introduce (products.archive, purchases.create, purchases.confirm,
 * purchases.cancel, sales.cancel, settings.edit, users.manage). `can()` and
 * `assertCan()` are typed against `Permission`, not `string`, so a typo'd
 * permission literal is a compile error, not a silent always-false check.
 */
export const ALL_PERMISSIONS = [
  "dashboard.view",
  "products.view", "products.create", "products.edit", "products.archive",
  "inventory.view", "inventory.receive", "inventory.issue",
  "inventory.adjust", "inventory.transfer", "inventory.count", "inventory.count_post",
  "reconcile.post", "adspend.manage",
  "warehouses.view", "warehouses.create", "warehouses.edit",
  "purchases.view", "purchases.receive", "purchases.create",
  "purchases.confirm", "purchases.cancel",
  "suppliers.view", "suppliers.create", "suppliers.edit",
  "sales.view", "sales.create", "sales.edit", "sales.return", "sales.cancel",
  "customers.view", "customers.create", "customers.edit",
  "expenses.view", "expenses.create", "expenses.edit", "expenses.cancel",
  "payments.view", "payments.create",
  "finance.view", "finance.view_cost", "finance.view_profit", "finance.manage_accounts",
  "reports.view", "reports.export",
  "settings.view", "settings.edit",
  "users.manage",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/**
 * Fixed Stage 1 role matrix. "*" means full access; otherwise a role holds an
 * explicit list of `Permission` strings. A custom permission editor arrives
 * in a later stage — until then this table is the single source of truth.
 */
export const PERMISSIONS: Record<Role, Array<"*" | Permission>> = {
  OWNER: ["*"],
  ADMIN: ["*"],
  ACCOUNTANT: [
    "dashboard.view",
    "products.view", "inventory.view", "warehouses.view",
    "purchases.view", "suppliers.view", "suppliers.create", "suppliers.edit",
    "sales.view", "customers.view",
    "expenses.view", "expenses.create", "expenses.edit", "expenses.cancel",
    "payments.view", "payments.create",
    "finance.view", "finance.view_cost", "finance.view_profit", "finance.manage_accounts",
    "adspend.manage",
    "reports.view", "reports.export",
    "settings.view",
  ],
  WAREHOUSE_MANAGER: [
    "dashboard.view",
    "products.view", "products.create", "products.edit",
    "inventory.view", "inventory.receive", "inventory.issue",
    "inventory.adjust", "inventory.transfer", "inventory.count", "inventory.count_post",
    "reconcile.post",
    "warehouses.view", "warehouses.create", "warehouses.edit",
    "purchases.view", "purchases.receive",
    "suppliers.view",
    "finance.view_cost",
    "reports.view",
    "settings.view",
  ],
  SALES_EMPLOYEE: [
    "dashboard.view",
    "products.view", "inventory.view", "inventory.count",
    "sales.view", "sales.create", "sales.edit", "sales.return",
    "customers.view", "customers.create", "customers.edit",
    "payments.create",
    "reports.view",
    "settings.view",
  ],
  VIEWER: [
    "dashboard.view",
    "products.view", "inventory.view", "warehouses.view",
    "purchases.view", "suppliers.view",
    "sales.view", "customers.view", "expenses.view",
    "reports.view",
    "settings.view",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  const granted = PERMISSIONS[role] ?? [];
  return granted.includes("*") || granted.includes(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ServiceError("FORBIDDEN", { role, permission });
}

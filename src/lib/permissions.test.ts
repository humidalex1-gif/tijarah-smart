import { describe, it, expect } from "vitest";
import { can, assertCan, ALL_PERMISSIONS, PERMISSIONS, type Permission } from "@/lib/permissions";
import { ROLES } from "@/lib/constants";

describe("permissions", () => {
  it("gives the owner everything", () => {
    expect(can("OWNER", "sales.create")).toBe(true);
    expect(can("OWNER", "users.manage")).toBe(true);
    // Cast: "*" must short-circuit even for a permission string outside the
    // known catalog (e.g. one added by a later stage before this file is
    // updated) — that robustness is what's under test, not a typo.
    expect(can("OWNER", "anything.at.all" as Permission)).toBe(true);
  });

  it("lets a sales employee sell but not buy or manage finance", () => {
    expect(can("SALES_EMPLOYEE", "sales.create")).toBe(true);
    expect(can("SALES_EMPLOYEE", "customers.create")).toBe(true);
    expect(can("SALES_EMPLOYEE", "purchases.create")).toBe(false);
    expect(can("SALES_EMPLOYEE", "finance.view")).toBe(false);
    expect(can("SALES_EMPLOYEE", "users.manage")).toBe(false);
  });

  it("lets a warehouse manager move stock but not sell", () => {
    expect(can("WAREHOUSE_MANAGER", "inventory.adjust")).toBe(true);
    expect(can("WAREHOUSE_MANAGER", "inventory.transfer")).toBe(true);
    expect(can("WAREHOUSE_MANAGER", "sales.create")).toBe(false);
  });

  it("lets an accountant handle money but not stock", () => {
    expect(can("ACCOUNTANT", "finance.view")).toBe(true);
    expect(can("ACCOUNTANT", "expenses.create")).toBe(true);
    expect(can("ACCOUNTANT", "payments.create")).toBe(true);
    expect(can("ACCOUNTANT", "inventory.adjust")).toBe(false);
  });

  it("gives a viewer read access only", () => {
    expect(can("VIEWER", "products.view")).toBe(true);
    expect(can("VIEWER", "products.create")).toBe(false);
    expect(can("VIEWER", "finance.view_profit")).toBe(false);
  });

  it("lets every role open settings but only owners and admins manage the team", () => {
    for (const role of ROLES) expect(can(role, "settings.view")).toBe(true);
    expect(can("OWNER", "users.manage")).toBe(true);
    expect(can("ADMIN", "users.manage")).toBe(true);
    expect(can("ACCOUNTANT", "users.manage")).toBe(false);
    expect(can("WAREHOUSE_MANAGER", "users.manage")).toBe(false);
  });

  it("throws FORBIDDEN when asserting a permission the role lacks", () => {
    expect(() => assertCan("VIEWER", "sales.create")).toThrow("FORBIDDEN");
    expect(() => assertCan("OWNER", "sales.create")).not.toThrow();
  });

  it("keeps every explicit role permission listed in ALL_PERMISSIONS", () => {
    // Guards the direction the type system can't: PERMISSIONS entries are
    // compile-checked against Permission already, but a stale ALL_PERMISSIONS
    // edit (e.g. a permission removed from the catalog but left on a role)
    // would still compile. This catches that drift at runtime.
    for (const role of ROLES) {
      for (const permission of PERMISSIONS[role]) {
        if (permission === "*") continue;
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  describe("stock count permissions", () => {
    it("lets a sales employee count but never commit the variance", () => {
      // The separation is the point: a shop assistant counts the shelf, a
      // manager reviews the variance and commits it.
      expect(can("SALES_EMPLOYEE", "inventory.count")).toBe(true);
      expect(can("SALES_EMPLOYEE", "inventory.count_post")).toBe(false);
    });

    it("gives a warehouse manager both", () => {
      // Posting a count is strictly weaker than inventory.adjust, which this
      // role already holds — gating it more tightly would be theatre.
      expect(can("WAREHOUSE_MANAGER", "inventory.adjust")).toBe(true);
      expect(can("WAREHOUSE_MANAGER", "inventory.count")).toBe(true);
      expect(can("WAREHOUSE_MANAGER", "inventory.count_post")).toBe(true);
    });

    it("gives an owner and an admin both", () => {
      for (const role of ["OWNER", "ADMIN"] as const) {
        expect(can(role, "inventory.count")).toBe(true);
        expect(can(role, "inventory.count_post")).toBe(true);
      }
    });

    it("gives read-only and finance roles neither, matching their lack of inventory.adjust", () => {
      for (const role of ["VIEWER", "ACCOUNTANT"] as const) {
        expect(can(role, "inventory.adjust")).toBe(false);
        expect(can(role, "inventory.count")).toBe(false);
        expect(can(role, "inventory.count_post")).toBe(false);
      }
    });
  });

  describe("reconciliation and ad spend permissions", () => {
    it("gives an owner and an admin both", () => {
      for (const role of ["OWNER", "ADMIN"] as const) {
        expect(can(role, "reconcile.post")).toBe(true);
        expect(can(role, "adspend.manage")).toBe(true);
      }
    });

    it("gives a warehouse manager reconciliation but not ad spend", () => {
      // Reconciling stock against the warehouse is this role's job. What the
      // business spends on advertising is not.
      expect(can("WAREHOUSE_MANAGER", "reconcile.post")).toBe(true);
      expect(can("WAREHOUSE_MANAGER", "adspend.manage")).toBe(false);
    });

    it("gives an accountant ad spend but not reconciliation", () => {
      // Ad spend is a period cost the finance role owns. Posting a stock
      // shortfall moves inventory, which this role cannot do anywhere else.
      expect(can("ACCOUNTANT", "adspend.manage")).toBe(true);
      expect(can("ACCOUNTANT", "reconcile.post")).toBe(false);
    });

    it("gives a viewer and a sales employee neither", () => {
      for (const role of ["VIEWER", "SALES_EMPLOYEE"] as const) {
        expect(can(role, "reconcile.post")).toBe(false);
        expect(can(role, "adspend.manage")).toBe(false);
      }
    });
  });
});

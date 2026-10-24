"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { createWarehouse, updateWarehouse } from "@/services/warehouses";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const checkbox = z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean());

const warehouseFields = {
  name: z.string().min(1),
  code: z.string().min(1),
  city: optionalText,
  isDefault: checkbox,
};

export const createWarehouseAction = action({
  permission: "warehouses.create",
  schema: z.object(warehouseFields),
  handler: async (input, ctx) => {
    const warehouse = await createWarehouse(ctx, {
      name: input.name,
      code: input.code,
      city: input.city ?? null,
      isDefault: input.isDefault,
    });
    return { id: warehouse.id };
  },
});

export const updateWarehouseAction = action({
  permission: "warehouses.edit",
  schema: z.object({ id: z.string().min(1), ...warehouseFields }),
  handler: async (input, ctx) => {
    const warehouse = await updateWarehouse(ctx, input.id, {
      name: input.name,
      code: input.code,
      city: input.city ?? null,
      isDefault: input.isDefault,
    });
    return { id: warehouse.id };
  },
});

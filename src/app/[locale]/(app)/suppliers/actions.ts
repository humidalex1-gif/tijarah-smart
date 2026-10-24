"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { createSupplier, updateSupplier } from "@/services/suppliers";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().finite().int().min(0).optional());

const supplierFields = {
  name: z.string().min(1),
  companyName: optionalText,
  contactPerson: optionalText,
  phone: optionalText,
  email: optionalText,
  country: optionalText,
  city: optionalText,
  address: optionalText,
  taxNumber: optionalText,
  paymentTermsDays: optionalInt,
  notes: optionalText,
};

function toServiceInput(input: z.infer<z.ZodObject<typeof supplierFields>>) {
  return {
    name: input.name,
    companyName: input.companyName ?? null,
    contactPerson: input.contactPerson ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    country: input.country ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    taxNumber: input.taxNumber ?? null,
    paymentTermsDays: input.paymentTermsDays,
    notes: input.notes ?? null,
  };
}

export const createSupplierAction = action({
  permission: "suppliers.create",
  schema: z.object(supplierFields),
  handler: async (input, ctx) => {
    const supplier = await createSupplier(ctx, toServiceInput(input));
    return { id: supplier.id };
  },
});

export const updateSupplierAction = action({
  permission: "suppliers.edit",
  schema: z.object({ id: z.string().min(1), ...supplierFields }),
  handler: async (input, ctx) => {
    const { id, ...rest } = input;
    const supplier = await updateSupplier(ctx, id, toServiceInput(rest));
    return { id: supplier.id };
  },
});

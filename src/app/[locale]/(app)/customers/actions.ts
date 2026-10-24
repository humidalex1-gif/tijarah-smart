"use server";

import { z } from "zod";
import { action } from "@/lib/action";
import { toMinor } from "@/lib/money";
import { CUSTOMER_TYPES } from "@/lib/constants";
import { createCustomer, updateCustomer } from "@/services/customers";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().finite().int().min(0).optional());
const optionalAmount = z.preprocess(emptyToUndefined, z.coerce.number().finite().min(0).optional());

const customerFields = {
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  name: z.string().min(1),
  phone: optionalText,
  email: optionalText,
  country: optionalText,
  city: optionalText,
  address: optionalText,
  taxNumber: optionalText,
  creditLimit: optionalAmount,
  paymentTermsDays: optionalInt,
  notes: optionalText,
};

function toServiceInput(input: z.infer<z.ZodObject<typeof customerFields>>) {
  return {
    customerType: input.customerType,
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    country: input.country ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    taxNumber: input.taxNumber ?? null,
    creditLimit: input.creditLimit !== undefined ? toMinor(input.creditLimit) : undefined,
    paymentTermsDays: input.paymentTermsDays,
    notes: input.notes ?? null,
  };
}

export const createCustomerAction = action({
  permission: "customers.create",
  schema: z.object(customerFields),
  handler: async (input, ctx) => {
    const customer = await createCustomer(ctx, toServiceInput(input));
    return { id: customer.id };
  },
});

export const updateCustomerAction = action({
  permission: "customers.edit",
  schema: z.object({ id: z.string().min(1), ...customerFields }),
  handler: async (input, ctx) => {
    const { id, ...rest } = input;
    const customer = await updateCustomer(ctx, id, toServiceInput(rest));
    return { id: customer.id };
  },
});

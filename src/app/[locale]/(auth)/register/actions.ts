"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { registerCompany } from "@/services/accounts";
import { signIn } from "@/lib/auth";
import { LOCALES } from "@/lib/i18n";
import { ServiceError } from "@/services/errors";

const schema = z.object({
  // Every message is a dictionary KEY, not English text — RegisterForm
  // resolves it through `labels.errors` before it ever reaches an Arabic
  // merchant, same convention as products/actions.ts's superRefine.
  fullName: z.string().min(2, "errors.INVALID_NAME"),
  companyName: z.string().min(2, "errors.INVALID_NAME"),
  email: z.string().email("errors.INVALID_EMAIL"),
  password: z.string().min(8, "errors.PASSWORD_TOO_SHORT"),
  // Same open-redirect reasoning as the login action, and this value is also
  // stored on User.preferredLanguage / Company.defaultLanguage.
  locale: z.enum(LOCALES),
});

export async function registerAction(_prev: unknown, formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "errors.generic", fields: parsed.error.flatten().fieldErrors };
  }

  try {
    await registerCompany({
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      password: parsed.data.password,
      companyName: parsed.data.companyName,
      preferredLanguage: parsed.data.locale,
    });
  } catch (error) {
    if (error instanceof ServiceError) return { error: `errors.${error.code}` };
    throw error;
  }

  await signIn("credentials", {
    email: parsed.data.email,
    password: parsed.data.password,
    redirect: false,
  });

  redirect(`/${parsed.data.locale}/onboarding`);
}

"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { LOCALES } from "@/lib/i18n";
import { appHomePath } from "@/lib/nav";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // z.enum, never z.string(): this value is interpolated into redirect() and
  // written to User.preferredLanguage. A posted "/evil.com" would emit
  // Location: //evil.com — an open redirect on the post-auth hop.
  locale: z.enum(LOCALES),
});

export async function loginAction(_prev: unknown, formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "auth.invalidCredentials" };

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
  } catch {
    return { error: "auth.invalidCredentials" };
  }

  // The app opens on quick entry, not the dashboard: the owner signs in to
  // RECORD something far more often than to read a figure. A role that cannot
  // open it is bounced to the dashboard by that page's own permission gate, so
  // this degrades on its own rather than needing a second rule here.
  redirect(appHomePath(parsed.data.locale));
}

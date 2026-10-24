"use server";

import { signOut } from "@/lib/auth";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";

export async function signOutAction(formData: FormData) {
  const raw = String(formData.get("locale") ?? "");
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  await signOut({ redirectTo: `/${locale}/login` });
}

"use server";

import { revalidatePath } from "next/cache";
import { loadAppContext } from "@/lib/appContext";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { acknowledgeSyncRuns } from "@/services/fasthub/syncRun";

/**
 * Dismisses the sync banner. The runs themselves are kept — this stamps
 * `acknowledgedAt`, so what the sync found survives being read.
 *
 * The company comes from `loadAppContext`, never from the form: a hidden
 * field carrying a company id would let anyone acknowledge anyone's alerts.
 */
export async function acknowledgeSyncAction(formData: FormData) {
  const raw = String(formData.get("locale") ?? "");
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  await acknowledgeSyncRuns(ctx);

  revalidatePath(`/${locale}`);
  revalidatePath(`/${locale}/dashboard`);
}

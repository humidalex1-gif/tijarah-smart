import Link from "next/link";
import type { Locale, Translator } from "@/lib/i18n";
import type { AccessExpiry } from "@/services/fasthub/tokenExpiry";

/**
 * A week's notice that the Fast Hub token is dying, on the screen the owner
 * opens every day, with the one action that fixes it.
 *
 * The token is pasted by hand and never renewed by the app, so until this
 * existed the first warning was the sync turning red the morning after.
 * Renders nothing when there is nothing to say — a daily "all fine" banner
 * trains the owner to stop reading banners.
 */
export function TokenExpiryNotice({
  expiry, locale, t,
}: {
  expiry: AccessExpiry;
  locale: Locale;
  t: Translator;
}) {
  if (!expiry) return null;

  const expired = expiry.state === "expired";
  const tone = expired
    ? "border-danger bg-danger-soft"
    : "border-warning bg-warning-soft";
  const message = expired
    ? t("fasthub.noticeExpired")
    : t("fasthub.noticeExpiresSoon", { count: expiry.daysLeft });

  return (
    <div
      // Not role="alert": server-rendered on load, not an interruption.
      role="status"
      className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 text-sm leading-relaxed text-navy ${tone}`}
    >
      <span className="min-w-0">{message}</span>
      <Link
        href={`/${locale}/settings/fasthub`}
        className="shrink-0 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface"
      >
        {t("fasthub.noticeRenew")}
      </Link>
    </div>
  );
}

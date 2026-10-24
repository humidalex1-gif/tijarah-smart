import { formatMoney } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

export function Money({
  minor, locale, currency, tone,
}: {
  minor: number;
  locale: Locale;
  // Required: the company's currencyCode, threaded down from loadAppContext().
  currency: string;
  /**
   * `auto` paints both directions, right for a balance. `loss` paints only
   * below zero: in a profit grid nearly every cell is positive, and a green
   * table says nothing, while a minus sign in Arabic-Indic digits under RTL
   * is the easiest character on the page to miss.
   */
  tone?: "auto" | "plain" | "loss";
}) {
  const className =
    tone === "auto" ? (minor < 0 ? "text-danger" : minor > 0 ? "text-success" : "")
    : tone === "loss" ? (minor < 0 ? "text-danger" : "")
    : "";
  return <span className={className}>{formatMoney(minor, locale, currency)}</span>;
}

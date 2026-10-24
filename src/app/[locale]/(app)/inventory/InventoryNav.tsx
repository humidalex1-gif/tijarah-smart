import Link from "next/link";
import type { Locale, Translator } from "@/lib/i18n";
import type { Role } from "@/lib/constants";
import { can } from "@/lib/permissions";

/**
 * Sub-navigation shared by every /inventory/* page: a tab row (overview,
 * movements, transfers) plus the four stock-operation entry points, each
 * gated on its own permission. Without this, the receive/issue/adjust/
 * transfer/transfers pages this task adds would be reachable only by typing
 * a URL — no link anywhere leads to them.
 */
export function InventoryNav({
  locale, role, t, active,
}: {
  locale: Locale; role: Role; t: Translator; active: "overview" | "movements" | "transfers" | "counts";
}) {
  const tabs = [
    { key: "overview" as const, href: `/${locale}/inventory`, label: t("inventory.title") },
    { key: "movements" as const, href: `/${locale}/inventory/movements`, label: t("inventory.movements") },
    // The transfers LIST is a read (gated on inventory.view, same as this
    // whole page — see transfers/page.tsx), not the write permission the
    // action buttons below require; only the receive-transfer PAGE itself
    // needs inventory.transfer.
    ...(can(role, "inventory.view")
      ? [{ key: "transfers" as const, href: `/${locale}/inventory/transfers`, label: t("inventory.transfersTitle") }]
      : []),
    // Unlike transfers, stock counts have no separate read permission —
    // inventory.count gates both seeing the list and starting a count, so
    // this tab and the "Start a count" button on the list page below both
    // gate on the same single permission.
    ...(can(role, "inventory.count")
      ? [{ key: "counts" as const, href: `/${locale}/inventory/counts`, label: t("counts.title") }]
      : []),
  ];

  const actions = [
    { key: "receive", href: `/${locale}/inventory/receive`, label: t("inventory.receive"), show: can(role, "inventory.receive") },
    { key: "issue", href: `/${locale}/inventory/issue`, label: t("inventory.issue"), show: can(role, "inventory.issue") },
    { key: "adjust", href: `/${locale}/inventory/adjust`, label: t("inventory.adjust"), show: can(role, "inventory.adjust") },
    { key: "transfer", href: `/${locale}/inventory/transfer`, label: t("inventory.transfer"), show: can(role, "inventory.transfer") },
  ].filter((a) => a.show);

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              active === tab.key
                ? "border-brand bg-brand text-brand-ink"
                : "border-line bg-panel text-navy hover:bg-surface"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink"
            >
              {a.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import type { Locale } from "@/lib/i18n";
import type { Permission } from "@/lib/permissions";

/**
 * The one list of primary navigation destinations.
 *
 * The sidebar renders it and the app layout resolves the current pathname
 * against it. Those were two hand-maintained lists until the Salla/3PL
 * screens were added to the sidebar only, which left reconcile, claims,
 * adspend and profit resolving to "dashboard" — wrong header title, wrong
 * highlighted link, on all four. One list cannot drift from itself.
 */
export const NAV_ITEMS: { key: string; href: string; permission: Permission }[] = [
  // First on purpose. It is the one screen meant to be reached on a phone
  // without reading the list, and it enters rather than analyses — the
  // dashboard below it does the analysing. Gated on `expenses.create`, the
  // strongest permission anything it can save requires.
  { key: "quick", href: "quick", permission: "expenses.create" },
  { key: "dashboard", href: "dashboard", permission: "dashboard.view" },
  // One box over products and orders; every role holds dashboard.view.
  { key: "search", href: "search", permission: "dashboard.view" },
  { key: "products", href: "products", permission: "products.view" },
  { key: "inventory", href: "inventory", permission: "inventory.view" },
  { key: "warehouses", href: "warehouses", permission: "warehouses.view" },
  { key: "purchases", href: "purchases", permission: "purchases.view" },
  { key: "suppliers", href: "suppliers", permission: "suppliers.view" },
  { key: "sales", href: "sales", permission: "sales.view" },
  { key: "customers", href: "customers", permission: "customers.view" },
  { key: "expenses", href: "expenses", permission: "expenses.view" },
  // The warehouse's own bill. Gated on expenses.create rather than a view
  // permission: the screen exists to POST it, and a read-only visit would
  // only show an upload box that refuses.
  { key: "warehouseInvoices", href: "warehouse-invoices", permission: "expenses.create" },
  { key: "finance", href: "finance", permission: "finance.view" },
  // Reconciliation with the fulfilment warehouse. `claims` and `profit` are
  // reads of what reconcile.post and adspend.manage produce, so they are gated
  // on the same permissions rather than on new view-only ones — nobody needs
  // to see what the warehouse owes without being able to act on it.
  { key: "reconcile", href: "reconcile", permission: "reconcile.post" },
  { key: "claims", href: "claims", permission: "reconcile.post" },
  { key: "adspend", href: "adspend", permission: "adspend.manage" },
  { key: "profit", href: "profit", permission: "finance.view_profit" },
  { key: "settings", href: "settings", permission: "settings.view" },
];

/**
 * Where the app opens once the owner is inside it.
 *
 * Four places need this same answer — the login redirect, the landing page's
 * call to action, the installed app's `start_url`, and the first entry in the
 * menu — and this project has already shipped a bug caused by two lists that
 * were meant to agree and quietly stopped. So it is derived from `NAV_ITEMS`
 * and pinned by a test, rather than written out four times.
 *
 * It is deliberately NOT the dashboard. The dashboard analyses; this screen
 * enters, and entering is what the owner opens the app to do. The dashboard
 * also has to stay `requirePermission`'s fallback for a refused screen — a
 * fallback pointing here would loop forever for anyone who cannot open it.
 */
export const APP_HOME = NAV_ITEMS[0]!.key;

export function appHomePath(locale: Locale): string {
  return `/${locale}/${NAV_ITEMS[0]!.href}`;
}

// Derived, never hand-written: segment -> key. Every nav item now has a real
// segment, since the locale root belongs to the public landing page.
//
// A MAP rather than a set, because the two are not always the same string:
// `warehouseInvoices` lives at `warehouse-invoices`, and returning the segment
// verbatim gave the layout a key no dictionary and no sidebar entry has — the
// same drift, arriving by a different door, that once left four screens
// showing the dashboard's title and highlight.
const NAV_KEY_BY_SEGMENT: ReadonlyMap<string, string> = new Map(
  NAV_ITEMS.filter((item) => item.href !== "").map((item) => [item.href, item.key]),
);

/**
 * Every (app) route lives directly under `/[locale]` with no further nesting,
 * so the first path segment after the locale IS the nav key. Anything
 * unrecognized falls back to "dashboard" — including the bare `/[locale]`
 * root, which is the public landing page and renders no sidebar at all, so
 * the value is never read there.
 */
export function activeNavKey(pathname: string, locale: Locale): string {
  const rest = pathname.slice(`/${locale}`.length).replace(/^\//, "");
  const segment = rest.split("/")[0];
  return (segment && NAV_KEY_BY_SEGMENT.get(segment)) || "dashboard";
}

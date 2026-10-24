import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { can } from "@/lib/permissions";
import { globalSearch } from "@/services/search";
import { SearchResults } from "./SearchResults";

/**
 * One box over products and orders.
 *
 * A plain GET form: the query lives in the URL, so a result page can be
 * refreshed, shared, and reached with the back button — none of which a
 * client-side search state gives. Gated on `dashboard.view`, which every
 * role holds; what a role may not SEE is filtered per section below, before
 * anything reaches the RSC payload.
 */
export default async function SearchPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;
  const query = typeof sp.q === "string" ? sp.q : "";

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "dashboard.view", locale);
  const t = await getTranslator(locale);

  const canProducts = can(ctx.role, "products.view");
  const canOrders = can(ctx.role, "sales.view");

  // Searched only when something may be shown: a role allowed neither section
  // gets no query at all, not an empty-looking one.
  const result = (canProducts || canOrders) && query.trim() !== ""
    ? await globalSearch(ctx.companyId, query)
    : { products: [], orders: [] };

  return (
    <div className="mx-auto max-w-2xl">
      <form method="get" className="mt-4">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder={t("search.placeholder")}
          autoFocus
          className="w-full rounded-xl border border-line bg-panel p-3 text-navy outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      </form>

      <SearchResults
        locale={locale}
        currency={ctx.currency}
        query={query}
        products={canProducts ? result.products : null}
        orders={canOrders ? result.orders : null}
        labels={{
          productsTitle: t("nav.products"),
          ordersTitle: t("nav.sales"),
          noResults: t("search.noResults"),
          sku: t("products.sku"),
          // Only the statuses these results actually carry, so no enum has
          // to be enumerated here and no key can reach the screen untranslated.
          status: Object.fromEntries(
            [...result.products, ...result.orders].map((r) => [r.status, t(`status.${r.status}`)]),
          ),
        }}
      />
    </div>
  );
}

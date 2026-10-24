import { notFound, redirect } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { CountEntryForm, type CountEntryFormLabels } from "./CountEntryForm";

export default async function CountEntryPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "inventory.count", locale);
  const t = await getTranslator(locale);

  // findFirst with an explicit companyId filter, never findUniqueOrThrow —
  // same tenant-boundary rule as every other detail page: a count id from
  // another company, or one that no longer exists, reads as a routine 404,
  // not a 500 or a cross-tenant leak.
  //
  // An explicit `select`, not `include` — narrowed to exactly the four
  // session scalars this page actually reads (id, countNumber, status,
  // warehouse.name). Nothing on StockCountSession is sensitive today, but a
  // `select` keeps it that way structurally: a future field added to the
  // model doesn't reach this page's props just by existing, the way an
  // `include`'s implicit "every scalar" would let it.
  const session = await prisma.stockCountSession.findFirst({
    where: { id, companyId: ctx.companyId },
    select: {
      id: true,
      countNumber: true,
      status: true,
      warehouse: { select: { name: true } },
      lines: {
        // snapshotQty is deliberately absent from this select. Blind
        // counting only works if the counter never sees the expected
        // quantity, and a value computed into a "use client" component's
        // props ships in the RSC payload whether or not it renders — exactly
        // like cost and profit elsewhere in this codebase. Omitting the
        // field from the QUERY, not merely from the props passed to
        // CountEntryForm below, is what makes that guard structural rather
        // than a discipline the next editor has to remember.
        select: {
          id: true, countedQty: true, recountRequested: true,
          product: { select: { nameAr: true, nameEn: true, sku: true } },
          variantId: true,
        },
        // `product.sku` ties for every variant line of the same product
        // (createStockCount creates one line per variant), and `id` is the
        // uuid Prisma assigns at insert, not a per-product sequence — so
        // `{ id: "asc" }` breaks the tie with a STABLE order, not just *an*
        // order. Without it, tied rows can silently swap position on every
        // router.refresh() (CountEntryForm calls one after each row save),
        // which reads as the list reshuffling mid-count.
        orderBy: [{ product: { sku: "asc" } }, { id: "asc" }],
      },
    },
  });
  if (!session) notFound();

  // recordCount/submitForReview both reject server-side (COUNT_NOT_COUNTABLE)
  // for anything but OPEN, so rendering the counting form for a REVIEW/
  // POSTED/CANCELLED session would only be a dead end after the fact. The
  // review screen (Task 9) is where that state gets explained — this screen
  // only ever serves OPEN sessions.
  if (session.status !== "OPEN") {
    redirect(`/${locale}/inventory/counts/${session.id}/review`);
  }

  // createStockCount (stockCount.ts) creates one line per VARIANT, not one
  // per product — a shirt in three sizes produces three lines that all
  // share the same product name and SKU. StockCountLine.variantId has no
  // `variant` relation in the schema (and adding one is a human-run
  // migration, decisions.md #4 — out of scope here), so the variant's
  // identity is joined in application code: one batched, tenant-scoped
  // query for every distinct variantId this session's lines carry, not one
  // query per line.
  const variantIds = [...new Set(
    session.lines.map((line) => line.variantId).filter((v): v is string => v !== null),
  )];
  const variants = variantIds.length > 0
    ? await prisma.productVariant.findMany({
        where: { id: { in: variantIds }, companyId: ctx.companyId },
        select: { id: true, name: true, sku: true },
      })
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const labels: CountEntryFormLabels = {
    product: t("dashboard.product"), variant: t("counts.variant"), sku: t("products.sku"),
    countedQty: t("inventory.countedQty"), status: t("app.status"),
    counted: t("counts.counted"), notCounted: t("counts.notCounted"),
    recount: t("counts.recount"),
    save: t("app.save"), loading: t("app.loading"), submitForReview: t("counts.submitForReview"),
    progressTemplate: t("counts.progressLine"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.INVALID_QUANTITY": t("errors.INVALID_QUANTITY"),
      "errors.COUNT_LINE_FOREIGN": t("errors.COUNT_LINE_FOREIGN"),
      "errors.COUNT_NOT_COUNTABLE": t("errors.COUNT_NOT_COUNTABLE"),
      "errors.COUNT_NOTHING_COUNTED": t("errors.COUNT_NOTHING_COUNTED"),
    },
  };

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold text-navy">
        {t("counts.startCounting")} — {session.countNumber}
      </h1>
      <p className="mb-6 text-sm text-muted">
        {t("counts.warehouse")}: {session.warehouse.name}
      </p>

      <CountEntryForm
        locale={locale}
        sessionId={session.id}
        lines={session.lines.map((line) => {
          const variant = line.variantId ? variantById.get(line.variantId) : undefined;
          return {
            id: line.id,
            countedQty: line.countedQty,
            recountRequested: line.recountRequested,
            productName: locale === "ar" ? line.product.nameAr : line.product.nameEn,
            variantName: variant?.name ?? null,
            // A variant's own SKU is what's physically on the shelf label;
            // the product-level SKU only applies to a simple product (no
            // variants) or a variant this tenant-scoped lookup didn't find.
            sku: variant?.sku ?? line.product.sku,
          };
        })}
        labels={labels}
      />
    </div>
  );
}

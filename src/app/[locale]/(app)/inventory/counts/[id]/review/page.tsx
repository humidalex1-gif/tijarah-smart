import { notFound, redirect } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { costOf } from "@/lib/money";
import { formatQty, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ReviewActions, RecountButton, type ReviewActionsLabels } from "./ReviewActions";

export default async function CountReviewPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  // NOT inventory.count. The review screen shows expected quantities — a
  // counter who could read it would learn the system's numbers, and
  // requestRecount would then hand them a fresh line for a product whose
  // expected value they now know. Blind counting would leak through the
  // recount cycle (spec §8).
  requirePermission(ctx, "inventory.count_post", locale);
  const t = await getTranslator(locale);

  // findFirst with an explicit companyId filter, never findUniqueOrThrow —
  // same tenant-boundary rule as the counting screen. An explicit `select`,
  // not `include` — narrowed to exactly what this page reads. `warehouseId`
  // is selected on its own (not just via the `warehouse` relation) because
  // the InventoryBalance lookup below needs the raw id.
  const session = await prisma.stockCountSession.findFirst({
    where: { id, companyId: ctx.companyId },
    select: {
      id: true,
      countNumber: true,
      status: true,
      warehouseId: true,
      warehouse: { select: { name: true } },
      lines: {
        select: {
          id: true,
          productId: true,
          variantId: true,
          variantKey: true,
          snapshotQty: true,
          countedQty: true,
          recountRequested: true,
          product: { select: { nameAr: true, nameEn: true, sku: true } },
        },
        // Same tie-break as the counting screen: product.sku ties for every
        // variant line of the same product, `id` breaks the tie stably.
        orderBy: [{ product: { sku: "asc" } }, { id: "asc" }],
      },
    },
  });
  if (!session) notFound();

  // The mirror image of the counting screen's own redirect: that page only
  // ever serves OPEN sessions and sends anything else here; this page only
  // ever serves REVIEW/POSTED/CANCELLED and sends OPEN back there.
  if (session.status === "OPEN") {
    redirect(`/${locale}/inventory/counts/${session.id}`);
  }

  // Variant identity, joined in application code exactly like the counting
  // screen: StockCountLine has no `variant` relation, and a multi-variant
  // product's lines all share the same product name/SKU without it. Select
  // ONLY `{ id, name, sku }` — a bare `include` would ship ProductVariant's
  // four price columns into this RSC's render, the same leak Stage 1B had
  // once before.
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

  // One bulk read of every balance this session's lines can touch, same
  // shape (and same rationale) as postStockCount's own balance query: a
  // per-line lookup would be an N+1 query against a session that can run to
  // thousands of lines.
  const balances = session.lines.length > 0
    ? await prisma.inventoryBalance.findMany({
        where: {
          companyId: ctx.companyId,
          warehouseId: session.warehouseId,
          productId: { in: session.lines.map((l) => l.productId) },
        },
        select: { productId: true, variantKey: true, availableQty: true, avgCost: true },
      })
    : [];
  const balanceFor = new Map(balances.map((b) => [`${b.productId}:${b.variantKey}`, b]));

  const canViewCost = can(ctx.role, "finance.view_cost");

  const rows = session.lines.map((line) => {
    // A missing balance row means the system believes there is none of this
    // here, same default postStockCount uses.
    const balance = balanceFor.get(`${line.productId}:${line.variantKey}`) ?? { availableQty: 0, avgCost: 0 };
    // null means nobody counted this line — never treated as zero.
    const variance = line.countedQty !== null ? line.countedQty - line.snapshotQty : null;
    // Measured against the LIVE balance vs the SNAPSHOT — deliberately NOT
    // `variance !== 0`. The shop keeps trading during a count: a line can
    // have zero variance (the counter's figure matched the snapshot) while
    // the live balance has already moved on since, or a real nonzero
    // variance while the live balance never budged. These are independent
    // signals; conflating them would flag (or clear) the wrong rows.
    const drifted = balance.availableQty !== line.snapshotQty;
    const varianceValue = variance !== null ? costOf(variance, balance.avgCost) : null;
    const variant = line.variantId ? variantById.get(line.variantId) : undefined;

    return {
      id: line.id,
      productName: locale === "ar" ? line.product.nameAr : line.product.nameEn,
      variantName: variant?.name ?? null,
      sku: variant?.sku ?? line.product.sku,
      snapshotQty: line.snapshotQty,
      countedQty: line.countedQty,
      variance,
      varianceValue,
      drifted,
      // A line can still carry recountRequested === true here: requestRecount
      // clears countedQty and flips the SESSION back to OPEN, but nothing
      // stops the counter from re-submitting for review without having
      // touched this particular line again. Surfacing it (same badge/label
      // CountEntryForm.tsx already uses for the same field) tells the
      // reviewer this row was already flagged once, not merely "never
      // reached" like a plain uncounted line.
      recountRequested: line.recountRequested,
    };
  });

  // Derived BEFORE posting, from the very rows rendered above — postStockCount
  // returns linesPosted/linesSkipped/movementsCreated only AFTER acting, so the
  // confirmation dialog (which must state impact before the merchant commits)
  // has to compute its own numbers from the session's current lines:
  //   - movingCount: lines with a nonzero variance — exactly the lines
  //     postStockCount will create a movement for (its own `delta !== 0` check).
  //   - uncountedCount: lines nobody has counted, which posting silently skips.
  //   - driftedCount: lines whose live balance no longer matches the snapshot
  //     (see `drifted` above) — a distinct concept from variance, so it is
  //     counted separately rather than folded into movingCount.
  const movingCount = rows.filter((r) => r.variance !== null && r.variance !== 0).length;
  const uncountedCount = rows.filter((r) => r.countedQty === null).length;
  const driftedCount = rows.filter((r) => r.drifted).length;

  const statusTone = session.status === "POSTED" ? "success" : session.status === "CANCELLED" ? "danger" : "warning";

  const columns: Column<typeof rows[number]>[] = [
    { key: "product", header: t("dashboard.product"), render: (r) => r.productName },
    { key: "variant", header: t("counts.variant"), render: (r) => r.variantName ?? "—" },
    { key: "sku", header: t("products.sku"), render: (r) => r.sku },
    {
      key: "expected", header: t("counts.expected"), align: "end",
      render: (r) => formatQty(r.snapshotQty, locale),
    },
    {
      key: "counted", header: t("inventory.countedQty"), align: "end",
      render: (r) => (
        // recountRequested takes priority over the plain "not counted" badge:
        // both states have countedQty === null, but this one was already
        // flagged for a fresh count once, not merely never reached yet.
        r.recountRequested
          ? <StatusBadge label={t("counts.recount")} tone="warning" />
          : r.countedQty !== null
            ? formatQty(r.countedQty, locale)
            : <StatusBadge label={t("counts.notCounted")} tone="neutral" />
      ),
    },
    {
      key: "variance", header: t("counts.variance"), align: "end",
      render: (r) => (
        r.variance !== null
          ? (
            <span className={r.variance > 0 ? "text-success" : r.variance < 0 ? "text-danger" : ""}>
              {formatQty(r.variance, locale)}
            </span>
          )
          : "—"
      ),
    },
    // The variance VALUE column is additionally gated on finance.view_cost,
    // absent from `columns` entirely (not merely hidden by CSS) when the
    // role lacks it — matching how the suppliers list gates its balance
    // column. Units (expected/counted/variance above) stay visible either way.
    ...(canViewCost ? [{
      key: "varianceValue", header: t("counts.varianceValue"), align: "end" as const,
      render: (r: typeof rows[number]) => (
        r.varianceValue !== null
          ? <Money minor={r.varianceValue} locale={locale} currency={ctx.currency} tone="auto" />
          : "—"
      ),
    }] : []),
    {
      key: "drift", header: t("counts.drifted"),
      render: (r) => (
        r.drifted ? (
          <div>
            <StatusBadge label={t("counts.drifted")} tone="warning" />
            <p className="mt-1 text-xs text-muted">{t("counts.driftedHint")}</p>
          </div>
        ) : null
      ),
    },
    // Only while the reviewer can still act on it — recounting a POSTED or
    // CANCELLED session's line would only hit the server's own
    // COUNT_NOT_COUNTABLE rejection.
    ...(session.status === "REVIEW" ? [{
      key: "recount", header: "",
      render: (r: typeof rows[number]) => (
        <RecountButton
          lineId={r.id}
          label={t("counts.recount")}
          loadingLabel={t("app.loading")}
          confirmTitle={t("counts.recountConfirmTitle")}
          confirmMessage={t("counts.recountConfirmMessage")}
          confirmLabel={t("app.confirm")}
          dismissLabel={t("app.cancel")}
          errors={{
            "errors.generic": t("errors.generic"),
            "errors.COUNT_LINE_FOREIGN": t("errors.COUNT_LINE_FOREIGN"),
            "errors.COUNT_NOT_COUNTABLE": t("errors.COUNT_NOT_COUNTABLE"),
          }}
        />
      ),
    }] : []),
  ];

  const labels: ReviewActionsLabels = {
    post: t("counts.post"),
    postConfirmTitle: t("counts.postConfirmTitle"),
    postConfirmMessage: t("counts.postConfirmMessage", {
      countNumber: session.countNumber,
      warehouse: session.warehouse.name,
      movingCount: formatNumber(movingCount, locale),
      uncountedCount: formatNumber(uncountedCount, locale),
      driftedCount: formatNumber(driftedCount, locale),
    }),
    cancel: t("counts.cancel"),
    cancelTitle: t("counts.cancelTitle"),
    cancelReason: t("counts.cancelReason"),
    cancelMessage: t("counts.cancelMessage", { countNumber: session.countNumber }),
    confirm: t("app.confirm"),
    dismiss: t("app.cancel"),
    loading: t("app.loading"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.COUNT_LINE_FOREIGN": t("errors.COUNT_LINE_FOREIGN"),
      "errors.COUNT_NOT_COUNTABLE": t("errors.COUNT_NOT_COUNTABLE"),
      "errors.COUNT_ALREADY_POSTED": t("errors.COUNT_ALREADY_POSTED"),
      "errors.COUNT_NOT_IN_REVIEW": t("errors.COUNT_NOT_IN_REVIEW"),
      "errors.COUNT_SHORTFALL_EXCEEDS_STOCK": t("errors.COUNT_SHORTFALL_EXCEEDS_STOCK"),
      "errors.REASON_REQUIRED": t("errors.REASON_REQUIRED"),
    },
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">
            {t("counts.review")} — {session.countNumber}
          </h1>
          <p className="text-sm text-muted">
            {t("counts.warehouse")}: {session.warehouse.name}
          </p>
          <div className="mt-1">
            <StatusBadge label={t(`status.${session.status}`)} tone={statusTone} />
          </div>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        empty={<EmptyState message={t("counts.empty")} />}
      />

      {session.status === "REVIEW" ? (
        <div className="mt-4">
          <ReviewActions sessionId={session.id} labels={labels} />
        </div>
      ) : null}
    </div>
  );
}

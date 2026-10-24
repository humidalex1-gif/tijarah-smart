# Stage 1A decisions binding on later stages

These are deliberate design choices made during Stage 1A that later stages
must not silently reverse. Each one was a live trade-off, not an oversight —
if a future task wants to change one, treat it as a design decision to revisit
explicitly, not a bug to fix in passing.

1. **Reporting/receivables must filter `status != "CANCELLED"` before trusting
   `paymentStatus`.** `cancelSale` never touches `paymentStatus` when it
   cancels an order, because `PaymentStatus` (`UNPAID` | `PARTIAL` | `PAID`)
   has no `REFUNDED` value to move it to — a cancelled order that was paid in
   full still reads `paymentStatus === "PAID"`. Any query that treats
   `paymentStatus` as "money currently owed or collected" must exclude
   cancelled orders first, or it will overstate paid revenue and understate
   receivables.

2. **The route layer must re-read membership from the DB before sensitive
   actions; the JWT is a cache, not authority.** Session rolling refresh
   carries stale claims past the 24h idle window, so a role change or
   deactivation does not take effect for an already-issued token until the
   route itself re-checks `Membership` in the database. Never authorize a
   sensitive action off the JWT's role claim alone.

3. **Role strings from any external input must be validated against `ROLES`
   before reaching `can()`.** `can()` silently maps an unrecognized role to
   zero permissions rather than failing loudly, so a raw-JSON caller without
   its own validation (an API route, a script) must guard the string against
   `ROLES` itself — see the pattern in `inviteUser` (`src/services/accounts.ts`).

4. **Schema changes require a human-run `db:push`; agents never run
   schema-mutating Prisma commands.** `tests/global-setup.ts` only verifies
   the schema is present and resets data between runs — it never provisions
   or migrates the schema itself. Provisioning `dev.db`/`test.db` is a
   deliberate manual step (see `prisma.config.ts` and the warning printed by
   `tests/global-setup.ts` when tables are missing).

5. **Expenses deliberately write no `Payment` row.** `addExpense` mutates
   `FinancialAccount.currentBalance` directly and writes an `Expense` row, but
   never a `Payment`. A future cash-transactions view built purely over
   `Payment` will miss every expense unless it unions in `Expense`, or this
   column decision is revisited.

6. **`WEIGHT` allocation reads live `product.weightGrams`.** `receivePurchase`
   allocates additional costs against the product's *current* weight at
   receive time, not a value captured when the PO was created. When product
   editing ships in a later stage, a weight edit between PO confirmation and
   receipt will change the allocation. Snapshot per-line weights at PO
   confirm if that drift becomes a problem.

7. **Damaged stock carries no cost basis; the damaged bucket ignores
   `allowNegativeInventory`.** Reclassifying `AVAILABLE` stock into `DAMAGED`
   is a write-off — `avgCost` is left untouched on the damaged IN movement,
   and inventory value is derived from `availableQty x avgCost` only, never
   from `damagedQty`. Independently, OUT movements against the `DAMAGED`
   bucket always enforce a hard floor at zero, even when the company has
   `allowNegativeInventory` set — damaged stock is physically counted, not
   modeled, so there is no meaningful "negative damaged" state.

8. **Sunk order costs are stored two different ways for the same economic
   end-state, deliberately.** `cancelSale` zeroes `grossProfit`/`netProfit`/
   `totalCost` outright — a cancelled order contributes nothing to profit. A
   full `processReturn`, by contrast, retains the order's allocated costs and
   nets `netProfit` down to `shippingCharged - Σallocated` (the shipping
   charged to the customer, less the order-level costs already allocated to
   now-returned lines). Both land the order at "no remaining profit
   contribution," but via different stored numbers — do not try to unify them
   without re-deriving both call sites' tests.

9. **~~Deferred to Stage 1B: error-code consolidation~~ — DONE, and this
   entry was left stale. Corrected 2026-07-30.** The original text said the
   overflow guards in `src/lib/money.ts` and `src/services/costing.ts` throw
   bare `Error("AMOUNT_OUT_OF_RANGE")` rather than `ServiceError`, so a route
   layer classifying on `ServiceError` would not catch them. Stage 1B fixed
   all three sites — they throw `ServiceError` now (`money.ts:51`,
   `money.ts:59`, `costing.ts:23`) — but nobody updated this entry, so anyone
   planning work in those functions designed around a constraint that no
   longer existed. Kept rather than deleted because the failure mode is the
   point: a decisions file that lags the code is worse than no decisions file,
   since it is trusted. If you resolve an entry here, say so in the same
   commit.

10. **A layout is presentation only, never an authorization gate — every page
    must call `loadAppContext()` itself.** Next.js renders a route's `layout`
    and `page` in parallel (not layout-then-page), and a shared layout is NOT
    re-rendered on client-side navigation between sibling segments underneath
    it. `(app)/layout.tsx` calling `loadAppContext()` therefore protects
    nothing by itself — the dashboard page (Stage 1B Task 4) is only safe
    because it independently calls `loadAppContext()` and re-checks
    permissions before rendering anything sensitive. Every later (app) page
    (Tasks 5–9) must do the same; do not assume the layout already gated
    access.
    Honest caveat: this is not a security gap, just a staleness one. Because
    each page re-reads `Membership` itself (decision #2), authorization is
    unaffected by the layout's parallel rendering or its lack of re-render on
    sibling navigation. What CAN lag on a soft (client-side) navigation is
    purely cosmetic and already-cached data the layout itself reads once per
    hard load: the onboarding-completed redirect and the `role` passed to
    `Sidebar`. A demotion or an onboarding-state change will not be reflected
    in the sidebar/nav until the next full page load, even though the
    destination page's own permission check is always current.

11. **`Brand` has a single `name` column — it is the one entity in a
    bilingual product that cannot be translated.** `ProductCategory` has
    `nameAr`/`nameEn` like every other user-facing label in the app, but
    `Brand` (Stage 1B Task 5) only has `name` (see `src/services/catalog.ts`'s
    `createBrand`). The products list, the product detail page, and
    `ProductForm` all render `brand.name` unconditionally regardless of
    locale, so an Arabic-locale merchant sees brand names exactly as typed,
    with no Arabic equivalent. This was a scope call for Stage 1B, not an
    oversight: a later stage that wants brand names to localize needs to add
    `nameAr`/`nameEn` to `Brand` deliberately (a schema change — decision #4
    applies) and update every read site above, not just patch one of them.

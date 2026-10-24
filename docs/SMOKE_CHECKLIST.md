# Smoke checklist — the full merchant loop

A manual, numbered pass through the whole Stage 1 flow: register a company,
onboard it, stock a product with real landed cost, sell it with live profit,
handle money and a return, and confirm the dashboard reconciles with the
records that produced it. Run it once fully in English, then repeat steps
marked **[critical path]** in Arabic (RTL) to catch anything locale-specific.

Prerequisites: `npm run seed && npm run dev`, or start from a fresh
register/onboard (the demo login `owner@tijarah.test` / `demo12345` already
has seeded data if you'd rather skip straight to step 6).

Each step names what you did and the result that means it passed.

## 1. Register **[critical path]**

1. Go to `/en/register` (or `/ar/register`). Fill business name, your name,
   email, and a password (8+ chars). Submit.
   **Expect:** redirected to the onboarding wizard, not the dashboard —
   a brand-new company always lands there until onboarding completes.

## 2. Onboard **[critical path]**

2. Step 1 — business details: confirm/edit the business name. Continue.
3. Step 2 — currency and tax: pick a currency (e.g. SAR), set a default tax
   rate (e.g. 15%). Continue.
   **Expect:** a nonsensical rate (negative, or over 100) is rejected with
   an inline message, not a server error.
4. Step 3 — warehouse and opening balances: name the main warehouse, and
   optionally set opening cash/bank balances. Submit.
   **Expect:** redirected to the dashboard. The sidebar and every nav item
   are now visible (they aren't during onboarding). If you set an opening
   cash/bank balance, the dashboard's **Cash & bank** KPI shows it
   immediately.

## 3. Add a product **[critical path]**

5. Go to **Products → Add product**. Fill Arabic name, English name, SKU,
   sale price, tax rate. Set an opening quantity, its warehouse, and a
   purchase (cost) price.
   **Expect:** product saves; product detail page shows the opening stock
   already received into that warehouse at that cost — no separate receipt
   step needed for the very first stock.
6. Open the product again and confirm the SKU is unique — try creating a
   second product with the SAME SKU.
   **Expect:** rejected with a clear "SKU already in use" message, not a
   generic error.

## 4. Purchase order with additional costs, then verify average cost

7. Go to **Purchases → New purchase order**. Pick a supplier and warehouse,
   add a line for an EXISTING product (one that already has stock, so you
   can watch its average cost move) at a cost price, and add at least one
   **additional cost** (e.g. shipping) with an allocation method (Value,
   Quantity, Weight, or Equal).
   **Expect:** the order summary shows subtotal, tax, and the additional
   cost total separately, and a grand total that sums them.
8. Confirm the purchase order (moves it out of Draft).
   **Expect:** an order still in Draft cannot be received — the Receive
   action is only available after confirming.
9. Receive the purchase order: accept the full ordered quantity (or split
   some into damaged, if the form offers it).
   **Expect:** receipt succeeds; the PO shows as received.
10. Open the product's detail page (or **Inventory**) and check its average
    cost.
    **Expect:** the new average cost reflects the weighted blend of the old
    stock's cost and the just-received cost **plus its allocated share of
    the additional cost** — it should have moved from what it was before
    step 9, not stayed exactly at the PO's bare per-unit price.

## 5. Sell it, verify profit and stock

11. Go to **Sales → New sale**. Pick (or add) a customer, add a line for the
    product from step 7, set a shipping-charged amount if you like, and
    confirm the sale.
    **Expect:** the sale confirms; **Inventory**'s available quantity for
    that product/warehouse has dropped by exactly the quantity sold.
12. Open the sale's detail page.
    **Expect:** gross profit and net profit are shown, and net profit is
    positive when the sale price exceeds the average cost carried into it.
    If you set a shipping-charged amount, net profit should reflect it
    (net profit = gross profit − allocated shipping/other order costs, plus
    shipping charged to the customer).

## 6. Record a payment

13. From the sale (if it wasn't paid in full at confirm) or from
    **Finance → Record payment**, record a customer payment against the
    order into a cash or bank account.
    **Expect:** the order's payment status moves toward Paid; the
    financial account's balance on **Finance → Accounts** increases by the
    payment amount.
14. Try recording a payment that exceeds what's still owed on the order.
    **Expect:** rejected — "payment exceeds total owed", not silently
    accepted or clamped.

## 7. Add an expense

15. Go to **Expenses → Add expense**. Pick a category, an amount, and a
    cash/bank account to pay it from.
    **Expect:** the expense saves; that financial account's balance on
    **Finance → Accounts** decreases by the expense amount (expenses write
    no `Payment` row by design — see `docs/decisions.md` #5 — so if you're
    checking cash by summing `Payment`, expenses won't be in that sum; the
    account balance itself is still correct).

## 8. Process a return

16. Open the confirmed sale from step 11. Start a return, select the line
    and a quantity up to what was sold, give a reason, and choose a refund
    destination (cash/bank or store credit, per what the form offers).
    **Expect:** return succeeds; **Inventory**'s available quantity for
    that product/warehouse goes back up by the returned quantity.
17. Check the order's net profit after the return.
    **Expect:** per `docs/decisions.md` #8, net profit nets down to
    `shippingCharged − Σallocated` (the returned line's allocated cost
    comes back out) — it does NOT simply zero out the way a full
    cancellation does. Don't expect it to match a fresh full-order profit
    calculation.
18. Try returning more than was sold on that line (e.g. return the same
    line a second time past what remains).
    **Expect:** rejected — "return exceeds sold quantity".

## 9. Cancel a sale

19. Create a second, separate sale (new order, don't reuse the one you
    already returned against) and confirm it.
20. Cancel that order.
    **Expect:** cancels successfully; **Inventory** shows the stock it had
    reserved/sold is back to available. The order's gross profit, net
    profit, and total cost are all zeroed (per `docs/decisions.md` #8 — a
    cancelled order contributes nothing to profit, unlike a return).
21. Check **Customers** for that customer's outstanding balance if the
    cancelled order had been marked paid.
    **Expect:** the cancelled order does NOT count as owed OR as paid
    revenue in any receivables total — `docs/decisions.md` #1 requires every
    money-owed query to exclude cancelled orders regardless of what
    `paymentStatus` still says on the row.

## 10. Dashboard reconciles **[critical path]**

22. Go to the dashboard. Note four figures: **Inventory value**, **Cash &
    bank**, **Receivables** (owed by customers), **Payables** (owed to
    suppliers).
23. Cross-check each one against its underlying screen:
    - Inventory value ↔ sum of "Inventory value" across every row on
      **Inventory** (all warehouses, no filter).
    - Cash & bank ↔ sum of every active account's balance on
      **Finance → Accounts**.
    - Receivables ↔ sum of "Balance owed" across **Customers**, filtered to
      customers who owe (`?filter=owing`).
    - Payables ↔ sum of "Balance owed" across **Suppliers**, filtered to
      suppliers owed money (`?filter=owing`).
    **Expect:** all four match exactly (to the minor currency unit).
24. Check the **Best sellers** table's per-product profit against the
    dashboard's own order-level profit KPI for the same date range.
    **Expect these do NOT match, and that's correct** — the dashboard shows
    an explanatory footnote (per `docs/decisions.md` #8 and the Task 4
    footnote): best-seller profit is computed per line item and excludes
    order-level `shippingCharged`, so it is deliberately not expected to
    tie to order-level net profit. Do not treat a mismatch here as a bug.

## 11. Repeat the critical path in Arabic

25. Switch language to العربية (or start fresh at `/ar/register`). Repeat
    steps 1, 2, 3, and 22-24 in Arabic.
    **Expect:** every label, error message, and number renders in Arabic
    (Arabic-Indic numerals via the app's number formatting), the page
    direction is RTL (sidebar on the right, text right-aligned), and the
    same reconciliation holds — the numbers are locale-independent, only
    their formatting changes.
26. At a phone width (~375px) in Arabic, open the sidebar via the hamburger
    button.
    **Expect:** the drawer slides in from the right (the "start" edge in
    RTL), a dark backdrop covers the rest of the page, and tapping the
    backdrop or a nav link closes it again.

## 12. Stock count, posted while the shop keeps trading

27. Sign in as the owner. Go to **Inventory → Stock counts → New count**,
    scope it to a whole warehouse, and start it.
    **Expect:** the counting screen lists every trackable product in that
    warehouse with no expected/system quantity shown anywhere — a counter
    should only ever see what they type in, never what the system already
    believes.
28. Count two products: enter the exact quantity the system already holds
    for one, and a SHORTER quantity (fewer units than expected) for the
    other. Save each row, then submit the count for review.
    **Expect:** submission succeeds and redirects to the review screen.
29. On the review screen, check the two lines you just counted.
    **Expect:** the matching line shows zero variance; the short line shows
    a negative variance and, if your role holds finance permissions, a
    negative variance value priced at the current average cost. Any line
    you didn't count shows "Not counted", never a zero or a dash.
30. While still in review, in another tab sell or receive stock against a
    third product this count covers (counted or not), then refresh the
    review screen.
    **Expect:** that product's line now carries a "Discrepancy" flag with a
    hint that stock moved since the count began — flagged because its live
    balance no longer matches the snapshot taken when the count started,
    independent of whatever you counted for it.
31. Pick one of the two lines you counted in step 28 and click its **Recount**
    button.
    **Expect:** a confirmation dialog states the real consequence — the line
    will be cleared for recounting AND the whole count returns to counting —
    before anything happens. Confirm it.
    **Expect:** you land back on the counting screen (not the review screen),
    the line you recounted shows empty/not-counted (its previous entry is
    gone), and the count's status is no longer "Review". Re-enter a quantity
    for that line and submit the count for review again.
    **Expect:** submission succeeds and you're back on the review screen,
    with every other line's earlier count still intact.
32. Post the count.
    **Expect:** the confirmation you accepted named how many lines would
    move stock and how many were never counted before you confirmed it, and
    posting succeeds.
33. Go to **Inventory → Movements** and find the new movement for the
    shorted product.
    **Expect:** the movement is tagged as coming from a stock count (not a
    plain adjustment), and the warehouse's available balance for that
    product moved by exactly the variance shown on the review screen — no
    more, no less.

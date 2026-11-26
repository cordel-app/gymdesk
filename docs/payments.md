# Payments

The two processes Gymdesk actually runs to take money: the **first payment** a member
makes themselves (customer-initiated, CIT) and the **recurring charge** the nightly run
makes on their stored card (merchant-initiated, MIT).

Written from the code on `main` at `0763562` (#791). Every statement below names the file
it came from, and every behaviour that does not exist yet is marked with the ticket that
would add it — this document describes what runs today, never what is planned.

- [A. First payment (CIT)](#a-first-payment-cit)
- [B. Recurring charge (MIT)](#b-recurring-charge-mit)
- [C. Reference](#c-reference)
  - [Data model](#data-model)
  - [Assigned Plan status model](#assigned-plan-status-model)
  - [Provider layer](#provider-layer)
  - [Money rules](#money-rules)
  - [Observability today](#observability-today)
  - [Manual test runbook](#manual-test-runbook)
  - [Open gaps](#open-gaps)

---

## A. First payment (CIT)

Nothing charges a member automatically until they have paid once through the hosted page:
the nightly run INNER JOINs `payment_methods` (`api/src/api/billing.ts`), and the only thing
that *stores* a card there is the payment webhook — `webhooks.ts:207` and `:277`, its
card-update and first-payment branches, are the only two `INSERT INTO payment_methods` in
the codebase (`DELETE /me/payment-method` is the only other writer, and it removes). So the
first payment is what turns an assignment into a billable one.

### A1. Member exists and has a login

| Step | Route | What it writes |
|---|---|---|
| Staff create the member | `POST /members` (`api/src/api/members.ts`) | a `members` row |
| Staff invite them | `POST /members/:id/invite` | a Clerk invitation; no Gymdesk row |
| Website self-registration (#599) | `POST /public/gyms/:gymRef/registrations` (`api/src/api/public-registrations.ts`, mounted in `app.ts:175`) | `clerkClient.invitations.createInvitation()` — an **invitation only**, no `user_memberships` row |
| The member links on first sign-in | `POST /me/link` (`meLinkRouter`, `api/src/api/me.ts:385`, mounted in `app.ts:215` **before** `tenantContext` because no membership row exists yet) | stamps the Clerk user id onto the `members` row |

Clerk **restricted mode** is a dashboard-only setting, not code — see
`docs/architecture.md` ("Required Clerk instance setting").

### A2. Staff assign a Plan

Three routes insert a `user_memberships` row, and all three write
`ASSIGNMENT_CREATION_STATUS` — **`draft`** since #1108 stage 1:

| Route | File |
|---|---|
| `POST /user-memberships` | `api/src/api/user-memberships.ts` |
| `POST /user-memberships/:id/assign-new-plan` | `api/src/api/user-memberships.ts` |
| `POST /membership-plans/:id/assign` | `api/src/api/membership-plans.ts` |

Each one, in the same transaction:

- records the transition in the audit log through `recordStatusChange()`
  (`api/src/api/billing-events.ts`; `user_membership` / `status_change`, `null → 'draft'` —
  an audit row, not a Billing Event, since #1325 PR 3);
- calls `snapshotAssignedPlan()` (`api/src/api/assigned-plan-snapshot.ts`) — the Assigned
  Plan owns the commercial configuration it was assigned with (#635 §11–§17).

What it does **not** write: a ProductSet version, a `payment_requests` row, or
a `payment_methods` row. A Draft is therefore **not billable and not bookable**: the nightly
run and `api/src/api/activity-eligibility.ts` both read `um.status = 'active'`.

### A2b. The Draft is committed

`POST /user-memberships/:id/activate` is the one `draft → active` transition, and it is
where #956's one-plan rule is enforced — the member may have been holding another plan the
whole time this one was configured, since a Draft is deliberately outside
`LIVE_ASSIGNMENT_STATUSES`. It answers `409 active_plan_exists` unless the caller confirms,
and supersedes on `confirm: true` through `supersedeLiveAssignments()` exactly as the insert
paths used to. `PUT /user-memberships/:id` refuses the flip and names this route, the way a
cancellation is refused and routed to `DELETE`.

Since #1108 stage 2 the ordinary path is **Save & Pay** — `POST /user-memberships/:id/save-and-pay`
— rather than that route: it is the point of no return for a Draft. The one-plan rule is asked
there (`409 active_plan_exists` unless `confirm: true`), so the replacement is confirmed before
the member is asked to pay, and the row moves to **`pending_payment`**: locked (it is in none of
the editable, attachable or applicable status lists), not the member's plan, not bookable, still
projected. A Draft whose first cycle owes **nothing** — a free plan, a Free Period — is committed
straight to `active` by the same route, because a pending state nothing can confirm would strand
it. Three things then move a pending row to `active`, all through the one `commitAssignment()` in
`api/src/api/assignment-commit.ts`, which supersedes whatever is still live with the confirmation
taken as given (the money has arrived, and a paid-up member must not be left planless):

- the provider's `completed` webhook (A5) — the member's own *Pay now* (`POST /me/payment-requests`
  accepts a pending row, ahead of an active one) or a staff-raised checkout link (`POST /payment-requests`);
- `POST /user-memberships/:id/record-payment` — a cash / manual first payment: a `cash` attempt on
  the version's initial Billing Event (below) plus the commit, one transaction, no card stored;
- a `payment_recorded` event appended through `POST /payments` against a pending row, so the
  Payments page's own recording activates it too.

**Since #1325 PR 3b Save & Pay also creates the member's Pending Payment ProductSet version**
(`importAssignmentAsProductSet(…, { pending: true })`, in `submitForPayment()`'s transaction):
the assignment's configuration frozen as the version's own rows, and the version's **initial
`payment_recorded` Billing Event written now, with its lines** — what the version owes on its
start date, the fee and every Product dated on it. Nothing is superseded and no obligations are
generated. Every payment raised for the pending assignment is then an **attempt on that one
event** (`openInitialEventForAssignment()`): the staff link and the member's Pay now carry its
`billing_event_id` for the event's own amount, the cash payment is a `payment_requests` row of
method `cash` on it. The commit (`commitAssignment()` → `importAssignmentAsProductSet()`) finds
the pending version and activates it through `activateWithEvents()`: the Active version
superseded, its obsolete future events replaced, the new version's generated, the assignment
re-projected.

**A version that follows a running one owes only what it adds (#1521, #2899).** `commitCharge()`
prices such a version (`previous_product_set_id` set) dated today as a delta against the previous
version: a carried line is not asked for again (a grown quantity owes the added units), an
**inherited** plan's Membership Fee is not asked for again, and the fee of each plan the version
**adds** — a plan whose snapshot the previous version does not link (`planSnapshotInheritedSql()`,
read through `planScheduledEvents(…, { newPlansOnly: true })`) — is owed exactly as on a first
version, Pre-paid Duration and alignment stretch included. Before #2899 every fee line was
dropped, so an Admin Draft adding a plan to a member who already held one reviewed at €0.00. A
recurring line is recognised across versions by its purchase (`line_ref`, #1865), never by its
Product (#3165): a second line of a Product the member already holds is a new obligation and its
first stretch is owed in full (matched by Product, it read as already paid and the review said
*Nothing is due today*); a plan's own Product lines carry no `line_ref` and match by Product. The
review, Save & Pay, the free activation and the Draft's initial-payment forecast group all read
this one figure, and reading it writes nothing.

**An added plan owes its own first cycle, whatever day it starts on (#3441).** The added plan's
lines are taken from its own start date with a first version's rule (`addedPlansFirstCycle()` in
`product-set-configuration.ts`, over `firstCycleEvents()`): the events on its start date and, for a
schedule with nothing on that date, its earliest event already due today. Before #3441 only what
fell on today was kept, so a plan added beside a running one that started tomorrow or last week
reviewed as *Nothing is due today* in the Summary and the Save & Pay modal and was charged later by
the nightly run instead. The added plan's included Products are its own first cycle too, never
matched against the previous version's lines. A first cycle after today is also a future period
the engine projects, so once the version has a recorded initial payment (`payment_recorded`, not
scheduled, not cancelled) `materialiseScheduledEvents()` drops exactly those `(date, assignment)`
lines (`dropPaidFirstCycle()`), and the period is charged once.

**A recurring Product follows its own frequency calendar** (#3165 stage 2). When a recurring
Product line is given a schedule (`allocateItemSchedules()`), it joins an existing schedule — the
plan's included — only when that schedule bills on the Product's own calendar
(`billsOnOwnCalendar()`, `domain/scheduleAllocation.ts`): monthly on the 1st, 4 weeks on the
2026-11-02 grid, weekly on Mondays, yearly on the purchase date's own anniversary. A plan schedule
opened before the billing calendar on its start date (the 7th) is therefore not joined: the
Product opens its own schedule on the 1st, is prorated to month end and bills its full amount on
the 1st. A plan's included Products keep joining the plan's schedule. The Initial Payment states
the proration a line applied beside its name (*Prorated: 9 of 30 days*, `lineProration()` in
`domain/checkoutSummary.ts`, the engine's `prorated_days` / `period_days`), never on a full period
nor on a Membership Fee whose split charge already states its prorated stretch.

**How an Initial Payment line reads its discounts (#3360).** A line's *before discounts* is its
regular price for the stretch it charges (`lineRegularTotal()`, `domain/checkoutSummary.ts`): the
engine's `regular_price` (unit × quantity) scaled by the line's proration, so a 7-of-30-days line
is measured against 7/30 of its price and the proration is never reported as a discount (the
Summary's *Total discounts* and the review's `financial_summary.initial_discounts` both use it). A
recurring Product line with a direct discount states its **list** price as its regular price and the
direct discount as a reason of its own (`manual_adjustment`, `direct_discount`): the loaders hand
the engine the line's `list_price` and `direct_discount_percent` beside the frozen `unit_price`
(`SimulationService.listUnitPrice` / `directDiscountPercent`), and the charge is still computed from
the frozen unit price exactly as before, so no amount moves. A replacement version that only grows a
line's quantity scales that line's regular price with its charge, so both describe the added units.
Example: two €30 lockers, a 50% Promotion and a 10% direct discount, 7 of 30 days: €14.00 before
discounts, −€7.70, €6.30.

**The Initial Payment's Unit price is what one unit is charged (#3381).** The column states the
line's `charged_unit_price` (`chargedUnitPrice()`, `domain/checkoutSummary.ts`): the engine's final
`amount` ÷ quantity, so every discount, benefit, adjustment and the proration are in it once. A
prorated line also reports `charged_unit_breakdown` (`quantity × unit_price × days/period_days`,
`unit_price` being one unit's full-period price after discounts), read back from the same `amount`
and the engine's proration, never re-priced. `unit_price` (the list price) stays on the shape for
the other readers. Example: one €15 locker at 50%, 7 of 30 days: 1.75 € (1 × 7.50 € × 7/30).

**Waiving one Initial Payment line (#3284 stage 2, migration 474).** While the cart is In Cart,
staff may waive one line of its Initial Payment (`POST /product-sets/:id/initial-payment/waive`,
PAYMENTS write, body `{ line_key }`) and revert it (`…/revert-waive`). Each line carries a stable
`line_key` (`initialPaymentLineKeys()`, `domain/initialPaymentWaiver.ts`: the plan assignment and
member of a fee or included Product, a recurring line's `line_ref`, a one-time purchase's id; a
repeated identity takes `#2`, `#3`). The waiver is a row of `initial_payment_waivers` on the cart
(`purchases`), and `initialCharge()` applies it after the engine priced the line: amount and net
0, quantity and regular price kept, the original reasons kept plus a `manual_adjustment` reason
coded `initial_payment_waive`. So the review's `amount_due`, the payment request, the cash/card/
Monei pay flows and the persisted `billing_event_lines` (which store the same `line_key`) are one
figure; the engine, the plan, its Promotions and every recurring obligation are untouched, and the
zero line still marks its date as paid up for the scheduled pass. One waiver is refused rather
than guessed: a Membership Fee that collects a Pre-paid Duration (`prepaid_fee`: the pre-paid
periods would stay prepaid yet unpaid). Since stage 4 (owner, 25 Nov) a waiver may take the whole
Initial Payment to zero (`would_leave_nothing_to_pay` is gone). Save & Pay then answers
`nothing_to_pay` and the Admin commits through `POST /product-sets/:id/activate`, which for a charge
waived to zero (`isWaivedToZero()`) runs `commitWaivedInitialPayment()`
(`api/src/api/waived-initial-payment.ts`) in one transaction under the set's lock: the charge is
re-priced, the initial `payment_recorded` event is written with every line (waived ones at €0.00)
by `ensureInitialEvent()`, a completed €0.00 `waive` attempt settles it (no provider call, nothing
collected), and `activateWithEvents()` generates the obligations, which skip the period that event
covers — so the waived first period is never charged by the nightly run. A stored waiver whose line no longer exists applies to nothing.
Since stage 3 a prorated Membership Fee with no Pre-paid Duration may be waived (its `fee_split`
carries a prorated stretch only, so `prepaid_fee` applies only when `fee_split.prepaid` or
`prepaid_periods` is set), and each line whose Waive is disabled carries `waive_refusal`
(`nothing_to_waive` · `prepaid_fee`), which the Admin words beside
the disabled button.

Nothing is superseded at Save & Pay time: a payment that never arrives leaves the member's
current plan exactly as it was, and the pending row is discarded through `POST /:id/close`,
which cancels the pending version with it (`cancelPendingSetForAssignment()`; refused with
`409 payment_unresolved` while an attempt on its event is still unresolved). See
[Assigned Plan status model](#assigned-plan-status-model).

**Cancelling a Pending Payment Purchase (#3355 stage 3).** Staff cancel the whole cart from the
Member card's Purchases tab (`POST /payments/purchases/:id/cancel`, PAYMENTS write, only a
`pending_payment` purchase). `cancelPendingPurchase()` (`api/src/api/purchase-cancellation.ts`)
asks the provider about every submitted attempt first and refuses a settled or unresolved payment
under the locks, exactly as below. With any Billing Event (the purchase's own, its Product Set's
or its one-time lines') the purchase is kept `cancelled`: the set through the #2747 cancel below,
a standalone checkout's event stamped `cancelled_at` with its open attempts `expired`, its pending
one-time Products `cancelled`. With none, what it added is hard-deleted and the empty cart with it.
The plans its checkout marked `to_be_canceled` / `to_be_reactivated` are restored either way (since
this stage the #2747 cancel and the 24 h expiry restore them too). Nothing is charged or refunded.

**Cancelling a Pending Payment Product Set (#2747).** Staff (`POST /product-sets/:id/cancel`,
PAYMENTS write) and the owning member (`POST /me/product-sets/:id/cancel`) can cancel a set that
awaits its first payment, and the set is **kept** as `cancelled` (migration 410: the status plus
`cancelled_at` / `cancelled_by`), unlike the `DELETE` route, which returns it to Draft (#1991
stage 4). `api/src/api/product-set-cancellation.ts` is the one place:

1. **Ask the provider first** (`reconcileSetPayments()`, outside any transaction): every attempt
   that was submitted and is still `pending` is read back through `settleFromProviderLookup()`.
   A captured payment is settled (the set activates, and the cancel then answers
   `409 not_pending_payment`); a refusal or expiry closes the attempt; an answer with no final
   outcome only records the provider's raw status in `provider_status`.
2. **Decide under the locks** (`pendingCancellation()`, `domain/productSet.ts`): a `completed`
   attempt is `409 payment_settled`; an attempt whose outcome is unknown or that the provider
   holds `AUTHORIZED` / `PENDING_PROCESSING` is `409 payment_unresolved`; a provider `PENDING`
   (the customer never submitted the card) does not block.
3. **Cancel, deleting nothing**: the set's Billing Events are stamped `cancelled_at` (#2480's
   mechanism, amounts untouched), their open attempts closed as `expired` with `provider_status`
   left exactly as the provider reported it, the assignment it carried `cancelled` (`closed_at`,
   a `status_change` audit row), its one-time purchases `cancelled`, its plan snapshots follow
   the set. The owner's in-flight slot is free again. A second cancel answers 200 and changes
   nothing.

Since stage 2 this is what every Cancel button on a version awaiting payment does in the Admin,
after a confirmation. The Members App's Cancel is #3309's, below.

**A checkout awaiting payment expires after 24 hours (#3307 stage 3, migration 483).** This
replaces #1991 stage 4's two-hour return to Draft (and its "the latest attempt is `expired`"
trigger): `POST /billing/cleanup` runs `expirePendingPayments()` (same module) over every set
pending for `PENDING_EXPIRY_HOURS` (24) since `product_sets.pending_at`. Each one goes through
steps 1 and 2 above and then step 3 with `{ expire: true }`, which differs only in what it writes:
the events also take `billing_events.expired_at` (so they are shown as **`expired_24h`**, *24h
expired*, by `displayBillingEventStatus()`, while every reader of money, actions and queues sees
the cancelled event it already handles), and the one-time purchases still `pending_payment` —
linked to the set or joined from the cart — become **`cancelled`**, as with any cancelled checkout
(#3307 stage 7, migration 489: `expired_24h` is the Billing Event's display status only; the set and
its plan stay `cancelled` too, and products in any other status are untouched). The
actor is `System`. A captured payment activates the set; an in-flight or unknown one leaves it
pending for the next run; a second run finds no pending set and changes nothing. The response
reports `pending_payments_expired`.

**A member cancelling their own pending payment (#3309).** `POST /me/product-sets/:id/cancel`
ends the **payment attempt**, not the purchase: `returnCancelledCheckoutToCart()` (same module)
runs the same provider read-back and the same `pendingCancellation()` guard, then closes the set's
open attempts as **`cancelled`** (migration 477 widens `chk_payment_requests_status`; `expired`
stays a real timeout, and `provider_status` keeps whatever the provider answered), stamps the
initial event `cancelled_at` (kept, with its lines and amount, in the payment history), unlinks
the set's one-time purchases and the standalone cart purchases it joined from that event and
moves the set, its purchases and its linked assignment back to **`in_cart`** with the
configuration untouched. The member pays again through the existing Save & Pay, which writes a
**new** initial event (`ensureInitialEvent()` ignores a cancelled one) and a new attempt on it. A
repeated cancel on a set already back in the cart answers 200 and changes nothing. A payment that
settles afterwards on the cancelled attempt is recorded (a `completed` payload may reopen a
`cancelled` attempt, as it may an `expired` one) but activates nothing, and staff refund it.
Staff cancellation and the expiry/`DELETE` return to Draft are unchanged.

A payment that arrives after the cancellation is recorded on its attempt but activates nothing
(the event is cancelled, #2533 stage 2, and `activate()` refuses a `cancelled` set). The money is
then a collected payment on a cancelled event, refunded by staff through the existing Billing
Event refund; nothing refunds automatically.

### A2c. The Members App's Pay is refused when the shown total is stale (#3312 stage 2)

A member's cart can change while the page that shows its total is open (another tab, another
family device). The Members App therefore sends the total it showed with Pay —
`expected_amount` on `POST /me/product-sets/:id/save-and-pay` and `POST /me/cart/checkout`
(`checkoutRequestBody()`, `apps/member/src/lib/memberProducts.ts`) — and the server compares it,
never charges it (`api/src/domain/expectedCheckoutAmount.ts`, in cents):

| Where | Check | On mismatch |
|---|---|---|
| Save & Pay, before any write | `commitCharge()` vs `expected_amount` | `409 { error: 'amount_changed', amount }`, nothing written |
| Save & Pay, in the commit transaction | the set row locked (`lockSet()`, the lock every Draft writer takes through `lockDraft()`), `commitCharge()` re-priced inside it and compared with the figure the checkout will charge | the transaction is not started onward: same `409`, the set stays `in_cart`, no Billing Event, no payment request |
| Standalone cart checkout, before the provider call | `cartTotal()` vs `expected_amount` | `409 amount_changed` with the current total; no provider request, no row |

The client reloads the cart and its Summary on that refusal and shows
`membership.cart_error_amount_changed`; tapping Pay again sends the refreshed total. An absent
`expected_amount` is no expectation (the Admin's Save & Pay sends none), and a malformed one is a
`400`. The amount charged is always the server's own figure.

### A3. A payment request is raised

Two routes, same shape:

| | Staff | Member |
|---|---|---|
| Route | `POST /payment-requests` (`api/src/api/payment-requests.ts`) | `POST /me/payment-requests` (`api/src/api/me.ts:1599`) |
| Gate | `requireModuleWrite('PAYMENTS')` | `requireRole('member')`, **3/hour** per Clerk user id |
| `source` | `admin` | `customer` |
| Records who | `created_by` = the staff member's name (#1182; `initiated_by` is frozen history) | `consent_given_at = UTC_TIMESTAMP()` |

Both then do exactly the same thing:

1. **Price the cycle.** `currentMembershipFee(gymId, umId)`
   (`api/src/api/membership-fee-pricing.ts`) → `priceMembershipFeeOn(row, currentCycleDate(row))`.
   A fee of `0` is refused with `400 This membership owes nothing for its current billing
   cycle` — the provider is never called and no row is written. Since #946 this is also how a
   **Pre-paid Duration** is collected: the first of its periods prices at
   `regular x pay_beforehand_periods`, so a brand-new assignment on a Plan with 3 pre-paid
   months asks for `€210` here. Before that ticket it priced at `0` and the request was
   refused, which left a prepaid assignment with no stored card and therefore unbillable for
   ever.
2. **Look up the charge type** — `charge_types` where `code = 'membership_fee'` (a global
   lookup with no `gym_id`, seeded by migration 008). Missing ⇒ `500`.
3. **Call the provider** — `createPaymentRequest()` with the amount in **minor units**
   (`toMinorUnits(fee)`, `api/src/payments/money.ts`) and
   `generatePaymentToken: true`, which is what makes the `completed` webhook carry a
   reusable token for the MIT run.
4. **Insert the `payment_requests` row** — `status = 'pending'`, `amount` the *euro*
   decimal (`fee.toFixed(2)`), a fresh `page_token` (UUID v4) and
   `page_token_expires = now + 10 minutes`.
5. **Answer** `201 { id, checkoutUrl }`, where `checkoutUrl` is
   `${PAYMENT_PAGE_URL}/<locale>/checkout?token=<page_token>` (#1480): the locale is the
   **payer's** — their stored `preferred_locale` (#1039), else the language of their own
   request, else the base locale — never the language of the staff member who raised it.
   `buildCheckoutUrl()` (`api/src/domain/checkoutUrl.ts`) is the one place the URL is
   spelled and `payerCheckoutUrl()` (`api/src/api/checkout-url.ts`) the one place the
   language is decided; the page reads the locale from the path (`apps/payment/js/i18n.js`)
   and `/checkout` without one still renders, in Spanish, for links already in flight.
   The return URLs (`PAYMENT_OK_URL` / `PAYMENT_KO_URL`) stay locale-less (§A4, #1081).

`user_membership_id` is optional on the member route: since #956 (migration 213) a member
holds **one** live Membership Plan, so there is only ever one candidate and the member is
never asked which. The parameter is still accepted — it narrows the read to the row it
names, which keeps a client written against #634 working — and #634's
`409 multiple_active_memberships` is gone with the state that produced it.

### A4. The hosted page

`apps/payment/` is a static app (vanilla JS, nginx, no Node — see `docs/decisions.md` §8)
served at `pay.vdicube.com`. `apps/payment/js/checkout.js` reads the `token` query
parameter and calls the **only** bridge into the API:

`GET /payment-page/token/:token` (`api/src/api/payment-page.ts`, no auth, 20 req/min per IP)

- reads the row `FOR UPDATE` where `page_token = ? AND page_token_expires > UTC_TIMESTAMP()
  AND status = 'pending'`, then **sets `page_token = NULL`** — a single-use token, and the
  only writer that clears the column on a row still `pending`, which is what makes that NULL
  usable as the record that the page was **opened** (§B8, #789);
- returns display fields only: `{ paymentId, purpose, amount, currency, gymName,
  memberName, billingInterval, logoUrl, logoContainsGymName, themeColors, okUrl, koUrl }`.
  No Gymdesk internal id, and `paymentId` is the Monei payment id stored in `provider_ref`.
  `logoUrl` (nullable) and `logoContainsGymName` come from the gym's theme (#488);
  `themeColors` (#489 stage 4, nullable) is a curated subset of `tokens.colors` — page/card
  background, card border, text/muted text, primary button and its text, status error,
  separator, input border/background — not the full tokens blob, since typography and
  `advanced` are not used on this unauthenticated page.
- `purpose` is `membership_fee` or `card_update`, derived from the row's `source` and
  deliberately **not** inferred from `amount` (#788) — a fee of 0 is not payable at all.

The page then renders Monei's `CardInput`, requires the consent checkbox, and calls
`monei.confirmPayment()`; 3DS happens inside Monei. Card data never reaches a Gymdesk
server.

**The page confirms the payment with the API as soon as `confirmPayment()` resolves**
(#2087), whatever status it resolved with: `POST /payment-page/payments/:paymentId/confirm`
(`api/src/api/payment-page.ts`, no auth, 20 req/min per IP, through the same `/payment-page/`
proxy). The API reads the payment **back from MONEI** (`getPaymentStatus()`, `GET
/v1/payments/{id}` with our API key), checks that MONEI's `orderId` is the row's
`provider_order` (409 otherwise) and settles through §A5's `settlePaymentRequest()`. The
request body is never read — the browser's status is a prompt to ask MONEI, never evidence.
The page waits at most 8 s for the answer: `completed` goes to the OK page, `failed` /
`expired` to the KO page, and anything else (`pending`, `502 { status: 'unknown' }` when MONEI
cannot be reached, a timeout) falls back to MONEI's own result, as before. When
`confirmPayment()` returns a 3DS redirect instead, the page leaves and the **Members App's
return page** makes the same call with the `id` MONEI appends to `completeUrl`
(`returnedPaymentId()` in `apps/member/src/lib/paymentReturn.ts`). The webhook stays the
fallback (§A5).

**The return carries no locale** (#1081). `okUrl`/`koUrl` are `PAYMENT_OK_URL` /
`PAYMENT_KO_URL` verbatim (plus `purpose=card_update` where `withPurposeParam()` appends
it), and those are **one deploy-time value for every member of every gym** — so the API
cannot build them per member and they must not name a language: a fixed
`https://members…/es/payment/success` landed an English- or Catalan-speaking member on the
Spanish result page. They point at the locale-less `…/payment/success` and
`…/payment/error`, and the Members App's own middleware is what localizes the landing —
next-intl's locale detection redirects to the `NEXT_LOCALE` cookie's language, then
`Accept-Language`, then `en`, preserving the query string that carries `purpose`. A
signed-in member whose stored `preferred_locale` (#1039) differs is then moved onto it by
`MemberLocalePreference`, which the locale layout mounts over every route including these
two, so the stored preference has the last word. Both pages stay **outside**
`isPublicRoute`: each polls an authenticated route (`/me/payment-requests`,
`/me/payment-method`), so there is nothing to show a visitor with no session, and
sign-in-then-back lands on the locale-less path which redirects again.
`api/src/test/payment-return-locale.unit.test.ts` is the gate — the rule is a property of
`.env.example` and the Members App middleware, and nothing at runtime would notice a locale
creeping back in.

### A5. The webhook settles it

`POST /webhooks/payment` (`api/src/api/webhooks.ts`), mounted in `app.ts` **before**
`express.json()` with `express.raw({ type: '*/*' })` so the HMAC can be verified against the
exact bytes Monei signed. 60 req/min per IP.

**What arrives, and what signs it.** Every payment we create names this route as its
`callbackUrl`, and MONEI posts that callback as the **bare Payment object** (`id`, `orderId`,
`status`, `paymentToken`, …) signed with the **API key** (`MONEI-Signature: t=…,v1=…` over
`timestamp.body`). An account webhook configured in the dashboard is a different shape — an
envelope `{ id, type, objectType, object }` — signed with `MONEI_WEBHOOK_SECRET`.
`verifyAndParseWebhook()` (`payments/providers/monei/webhook.ts`) accepts both and checks the
signature against both keys; until it did, a payment callback was refused or matched no
request, so every payment stayed `pending` whatever its outcome.

**Since #1083 Monei does not call this route directly.** It posts to the isolated payment
app — `PAYMENT_NOTIFICATION_URL` is `https://pay.vdicube.com/webhooks/payment` on dev and
`https://pay.cordel.tech/webhooks/payment` on pro — and that app's nginx relays the request
here at the API's **internal** address, so the provider needs no public route to the API.
The relay is one `location = /webhooks/payment` block in
`apps/payment/templates/default.conf.template`, and three of its properties are the point
(`decisions.md` #19):

- **It verifies nothing.** The body and Monei's signature header are relayed byte for byte,
  `parseWebhook()` is still the first operation of this route, and `MONEI_WEBHOOK_SECRET`
  never leaves the API. A tampered body is still a 400 from the API, relayed as such.
- **Monei gets the API's own status code.** `proxy_intercept_errors` stays off and the block
  has no `return` and no `error_page`: a blanket 200 loses a confirmation, because Monei
  retries exactly what we report as failed. An unreachable or slow API is a 502/504, which
  is also a retry.
- **The 60/min budget is keyed on the client, not on the relay.** This is the one route that
  sits behind one more proxy than `trust proxy` accounts for, so the key comes from
  `paymentWebhookClientKey()` (`api/src/domain/forwardedClient.ts`), which adds
  `PAYMENT_WEBHOOK_RELAY_HOPS` to `TRUST_PROXY_HOPS`. Keyed on the relay, one gym's payment
  traffic would spend every gym's budget. The setting defaults to `0`, where the key is
  `req.ip` exactly as before #1083; the extra hop is declared per route rather than by
  raising `TRUST_PROXY_HOPS`, because a global raise makes Express trust one more
  caller-supplied `X-Forwarded-For` entry on every route that is still publicly reachable.

Nothing below this paragraph changes with the relay — the route, its branches and its
idempotency are what they were.

**One settle function, three callers** (#2087). Everything the webhook does after
`parseWebhook()` is `settlePaymentRequest()` in `api/src/api/payment-settlement.ts`, and it is
called by:

- the webhook (`via: 'webhook'`), with the payload exactly as before;
- the hosted page's confirmation (`via: 'confirm'`, §A4) and the cleanup (`via: 'cleanup'`,
  §B8), both through `settleFromProviderLookup()` with the payment the API **read back**.
  A read is judged by MONEI's raw status through `classifyProviderStatus()`
  (`domain/providerPaymentStatus.ts`) instead of the adapter's four-value map, which reads
  `CANCELED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `PAID_OUT` and anything unknown as `failed`
  (`PENDING_PROCESSING` reads `pending` since the November 2026 fix): asking a moment after the card was
  submitted is exactly when an in-flight status is likely. Only `settled` (completed) and
  `unsuccessful` (failed / expired) move a row; in flight, refunded and unknown write nothing.

Whichever arrives first settles; the others find the row `completed` and skip it. The row is
read **`FOR UPDATE` inside the transaction that settles it** — until #2087 it was read
outside the transaction with no lock, so two deliveries landing together could both pass the
check below and the branch that records a request with no Billing Event wrote two. Every log
line carries `via`.

> **Decisions (2026-10-25, #2087)** — change them here if they turn out wrong:
> - The page confirms after **every** `confirmPayment()` result, not only `SUCCEEDED`, so a
>   failure is recorded at once too.
> - One public confirm route serves the hosted page and the Members App's 3DS return page.
> - The confirm route answers a row already `completed` or `failed` from our row, without
>   asking MONEI again.
> - No migration and no stored "confirmed via" column: `via` is a log field.

- `parseWebhook()` verifies the HMAC as its **first** operation
  (`api/src/payments/providers/monei/webhook.ts`: `HMAC-SHA256` over `${t}.${rawBody}`,
  compared with `crypto.timingSafeEqual`). Invalid ⇒ `400`, **no DB query at all**.
- This is a MONEI Connect *partner-account* webhook, so the body is an event envelope
  (`{ id, type, objectType, objectId, accountId, object }`). A non-`charge` `objectType` is
  acked by returning `orderId: ''`, which matches no row.
- Status mapping: `SUCCEEDED → completed`, `FAILED → failed`, `EXPIRED → expired`,
  `PENDING`/`PROCESSING`/`AUTHORIZED` → `pending`, anything unknown → `failed`.
- `GET /webhooks/payment` answers `200 { ok: true }` unauthenticated, because Monei's
  dashboard preflights a new webhook URL with a GET and rejects a non-2xx.

The row is found by `provider_order = payload.orderId`. No row ⇒ `200` and a warning.
Then the row must be **processable**, which since #789 is two cases, not one:

```ts
pr.status === 'pending' || (pr.status === 'expired' && payload.status === 'completed')
```

Anything else is skipped as already processed, and that skip is what makes the handler
idempotent under Monei's retries — an already-`completed` row is *always* skipped, so nothing
may widen it further. The second clause is deliberately narrow: the provider is the source of
truth about money, so a `completed` payload is allowed to reopen a row cleanup had written
off (logged as `Payment webhook: completing a request cleanup had already expired`), while a
`failed` or `expired` payload never revives a terminal row.

That clause is the **backstop**, not the normal path. The primary fix is that cleanup no
longer expires a request the member is still paying through at all — §B8.

Then, by branch:

| Branch | What it writes |
|---|---|
| `completed` **and** `source = 'card_update'` | the request → `completed`, and the `payment_methods` upsert. **Nothing else**: no Billing Event, no `next_billing_date`, no dunning reset (#788 — replacing a card is not paying) |
| `completed` | the five writes below, in one transaction |
| `failed` / `expired` | `payment_requests.status` and `provider_ref` only — and only on a row still `pending`, since a terminal row is never revived by a non-`completed` payload |
| `pending` | **nothing** — an intermediate status must not flip the row, or the guard above would strand it before the real outcome arrives |

The `completed` transaction (`payment-settlement.ts`, the `completed` branch):

1. `payment_requests` → `status = 'completed'`, `provider_ref`, `completed_at`;
2. a `payment_recorded` Billing Event (`source = 'provider'`, `created_by` = `System`) carrying
   the request's own `amount` and `charge_type_id`;
3. `payment_requests.billing_event_id` ← that insert's `insertId`
   (read off the query result, *not* off `rows` — the defect #635 stage 3 fixed, which
   rolled back every real completion);
4. **only when `paymentToken` *and* `sequenceId` are present**: the `payment_methods`
   upsert (`ON DUPLICATE KEY UPDATE` on `(gym_id, member_id, provider)`, stamping
   `updated_at`).

Nothing stamps a billing date (#1325 PR 3c retired `next_billing_date` with #790's
`stampFirstNextBillingDate()`): the schedule is the ProductSet's persisted events, generated
from today onwards when the version is activated (step 6 below), so a back-dated assignment
is never charged the cycles that went by before it paid — which is what #790 protected.

> **Decisions (2026-09-27, #790)** — change them here if they turn out wrong:
> - **(a1) write-off.** The first payment covers every cycle that elapsed between a
>   back-dated `starts_at` and today. Those cycles are written off: nothing further is
>   owed, no catch-up charge, and no `adjustment` Billing Event records them.
> - **No confirm flag.** Back-dating `starts_at` stays allowed on all three insert paths,
>   with no "are you sure" step (#790 option (c) is out of scope) — the fix is in what the
>   webhook derives from `starts_at`, not in `starts_at` itself.
> - **A pause is not a debt.** Any transition back to `active` (Reactivate, or a status
>   flip through `PUT /user-memberships/:id`) whose `next_billing_date <= UTC_DATE()` walks
>   it forward, along its own schedule, to the first boundary strictly after today — the
>   cycles missed while paused are not collected (see "Assigned Plan status model").

> The other defect that lived in this step is closed too. **#789**: `POST /billing/cleanup` used to expire
> a request the member was still paying through, after which the guard above skipped the
> completed webhook as "already processed" and the charge was lost. Cleanup now keeps an
> opened request `pending` for hours — §B8.

**A paid event closes its other attempts.** Each Pay now raises a new attempt on the same
initial Billing Event, so when one completes, the webhook's `completed` branches (the fee and
the product purchase) mark every other `pending` attempt on that event `expired` and clear its
`page_token` (`closeSiblingAttempts()`, in the transaction that completes the paid one).
Otherwise the abandoned attempts kept My Products showing *You have a pending payment* with a
Pay now for a settled cycle. An expired attempt still accepts a later `completed` webhook
(#789), so this can never lose money that was in fact taken.

### A6. What is visible afterwards

| Surface | Route |
|---|---|
| Member's payment history | `GET /me/payment-requests` — excludes `source = 'card_update'`; a `product_purchase` row **is** listed (it is money), and the page's "finish your payment" prompt is what filters it out (#1121 stage 2) |
| Member's ledger and receipts | `GET /me/billing-events`, `GET /me/receipts/:billingEventId` |
| Member's plan, fee and upcoming charges | `GET /me/membership` (`me.ts:1384`) — `membership_fee` and `upcoming_payments` are both computed through `resolveMembershipFee()`, never read from a column |
| Member's own forecast of future billing events | `GET /me/billing-event-forecast` (#1123) — `assignedPlanBillingForecast()` scoped to the caller, so it is the **same** projection the staff see on the Assigned Plan card (#924 stage 4). The Payments card's *Next Payment* is its first group and *Forecast Billing Events* the rest, which is why neither can quote a total the nightly run will not charge |
| Staff transaction list / detail | `GET /payment-requests`, `GET /payment-requests/:id` — both exclude `card_update` |
| Staff ledger | `GET /payments/billing-events` |
| Members list badge | `GET /members` → `payment_status`, the status of the member's latest transaction that is neither `card_update` nor `product_purchase`, following `user_membership_members` so a family plan's covered members inherit the owner's (`api/src/api/members.ts:112-120`). The column is about the **membership fee**: a member halfway through buying a locker is not a member owing their fee |

---

## B. Recurring charge (MIT)

### B1. Trigger

`.github/workflows/billing-run.yml` fires `POST /billing/run` twice a day — `0 6 * * *` and
`0 10 * * *` UTC, the second being #781's safety net for a schedule GitHub dropped — then
`POST /billing/cleanup` (with `if: ${{ !cancelled() && steps.config.outcome == 'success' }}`,
so cleanup runs even when the charge step went red, but not when there is no API to call),
and since #900 `POST /promotion-lifecycle/run` under the same condition. That third step is
not a payments concern — it moves an `active` Promotion whose End Date has passed to
`expired` (`api/src/domain/promotionLifecycle.ts`) and charges nothing — but it rides this
workflow, and therefore this workflow's secret, rather than adding a third internal secret
to provision and rotate.

- Auth is `checkInternalSecret()`: the `X-Internal-Secret` header against
  `BILLING_INTERNAL_SECRET`. Both halves come from the same GitHub environment: the
  workflow sends its secret, and `deploy.yml` writes the same secret into the API's
  quadlet (it refuses to deploy while it is empty). Until 2026-09-27 neither side had it,
  so every scheduled run answered `401` and no recurring charge ran on `dev`.
- **The call arrives through the admin app** (#1086). `vars.API_BASE_URL` is the admin
  app's relay prefix — `https://admin.vdicube.com/api/internal` on `dev`,
  `https://admin.cordel.tech/api/internal` on `pro` — so the workflows still call
  `$API_BASE_URL/billing/run` unchanged while GitHub's runners no longer need a public
  API. `apps/admin/src/app/api/internal/[...path]/route.ts` forwards the POST to
  `CORDEL_FITNESS_API_URL` and hands back the API's own status and body byte for byte,
  so every check in `billing-run.yml` still reads what the API said. Three statuses are
  the relay's own rather than the API's: `404` (a path outside its allowlist of these four),
  `502`/`504` (it could not reach the API, or the API outlived
  `INTERNAL_RUN_RELAY_TIMEOUT_MS`, default 660 000 ms) and `500` (no API URL configured).
  It authenticates nothing — `BILLING_INTERNAL_SECRET` never leaves the API and
  `checkInternalSecret()` still answers the `401`. The one thing that changes on this side
  is the limiter's **key**, below. Full rules and the gate:
  `docs/architecture.md` → *Internal run auth*.
- There is **no** network-layer restriction: `/billing/*` and `/recurring-bookings/*` both
  are reached directly through Traefik with no IP restriction (#783; the nginx allowlist that was meant to sit in front never ran, as there is no nginx on corback). What stands in for one is
  a per-route rate limiter mounted in `api/src/app.ts` ahead of both internal routers
  (`internalRunLimiter`, config in `api/src/domain/internalRunRateLimit.ts`): per client IP,
  `INTERNAL_RUN_RATE_LIMIT_MAX` (default 10) failed attempts per
  `INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES` (default 15), one budget shared by
  `/billing/run`, `/billing/cleanup`, `/recurring-bookings/run` and `/promotion-lifecycle/run`.
  **Only a 401 spends it**,
  so a caller holding the secret — both of #781's daily attempts, and a run the guard
  answers `429 in_progress` or `200 already_completed_today` — never does. Once spent,
  every call from that address is `429` until the window ends, the right secret included.
  Since #1086 the key is the **client** address rather than the request's peer, through
  `internalRunClientKey()` (`api/src/domain/forwardedClient.ts`, adding
  `INTERNAL_RUN_RELAY_HOPS` to `TRUST_PROXY_HOPS`): the relay forwards the
  `X-Forwarded-For` it was called with, and keyed on the relay itself ten wrong guesses
  from anywhere would answer the nightly run `429` for the rest of the window. The setting
  defaults to `0`, where the key is `req.ip` exactly as before, and the hop is declared per
  route rather than by raising `TRUST_PROXY_HOPS` for #1083's reason.
- **Which environment** (#784). The job runs in `${{ inputs.environment || 'dev' }}`: a
  manual `workflow_dispatch` picks `dev` or `production` (default `dev`), and a scheduled
  run, which has no inputs, takes the literal on that line — `dev` until the `production`
  GitHub environment exists, then `production`. That line, marked
  `# #784: switch to 'production' once the environment exists`, is the only thing that
  changes, in `billing-run.yml` and `recurring-booking-run.yml` alike. The environment
  supplies both halves of the call: the secret (`BILLING_INTERNAL_SECRET`,
  `RECURRING_BOOKINGS_INTERNAL_SECRET`) and the host, the environment **variable**
  `vars.API_BASE_URL`. A first step checks the host is set and goes red with an explicit
  error if not; there is no hardcoded fallback. The deploy workflows take the same input
  (a push to `main` deploys to `dev`); the owner's steps are in
  [go-to-production.md §1](go-to-production.md#1-environment-and-secrets).

> **Decisions (2026-09-27, #784)** — change them here if they turn out wrong:
> - The workflow changes land first, against `dev`, with nothing changing behaviour; the
>   switch to `production` is one line per scheduled workflow, made after the environment
>   exists with its secrets (a workflow pointed at a missing environment runs with empty
>   secrets and answers `401`).
> - Once `production` exists the schedules target **`production` only**, and `dev` keeps
>   manual dispatch. A nightly charge against Monei test keys proves nothing a manual run
>   doesn't, and a red `dev` run at night trains people to ignore the email that means a
>   member wasn't charged (#778).
> - `ci.yml` stays on `dev`: CI needs no production secret.
> - `API_BASE_URL` is an environment **variable**, not a secret: a hostname is not a
>   credential, and seeing it in the run log is how a run that hit the wrong API is
>   diagnosed.
> - A manual run defaults to `dev`, so a dispatch nobody thought about never charges real
>   members.

> **Decisions (2026-09-27, #783)** — change them here if they turn out wrong:
> - Option B: the GitHub Actions IP allowlist on `location /billing/` is **removed rather
>   than automated**. It guarded nothing the secret does not, covered only one of the two
>   internal endpoints (`/recurring-bookings/` never had it) and decayed by hand, since
>   GitHub's ranges move and the refresh was a manual `scp`.
> - It is replaced by a per-route limiter so the secret cannot be ground at the global
>   500/15 min budget. Only failed-secret (401) responses count, so the legitimate
>   workflow can never lock itself out.
> - `BILLING_INTERNAL_SECRET` and `RECURRING_BOOKINGS_INTERNAL_SECRET` are rotated at
>   launch (`docs/go-to-production.md` §1), since the old value was only ever reachable from
>   GitHub's ranges and is now reachable from anywhere.
> - A PCI/QSA argument for restricting these routes at the network layer, if one ever
>   arises, reopens this.

### B2. The run guard

One **completed** run per UTC date, not "N hours since the last start" (#780).
`claimRun()`/`finishRun()` (`api/src/infra/run-log.ts`) with the decision in
`evaluateRunGuard()` (`api/src/domain/runGuard.ts`, pure, unit-tested):

| Situation | Answer |
|---|---|
| a run for today's `run_date` already reached `completed` | `200 { skipped_reason: 'already_completed_today', run_date, …zeroed counters }` — a green no-op, **never 429** |
| a row is `in_progress` and younger than `STALE_RUN_MINUTES` (30) | `429` |
| a row is `in_progress` and older | taken over; the stale row is closed as `failed` |
| a run started today and crashed | blocks nothing — the route's `catch` closes it `failed` |

The field is `skipped_reason`, never `skipped`, because the recurring booking run already
reports a numeric `skipped` counter. A new run status goes in **two** places: `RunLogStatus`
in `domain/runGuard.ts` and `chk_<table>_status` (migration 193).

### B3. Selection (#1325 PR 3)

The run is `executeDueScheduledEvents()` (`api/src/api/scheduled-event-execution.ts`) and
nothing else. It reads **no** `user_memberships` row: every committed assignment is a
ProductSet version whose obligations were persisted as Billing Events when it was committed
(`materialiseScheduledEvents()`), so the schedule *is* the ledger.

```sql
SELECT be.id, be.gym_id, be.product_set_id, be.member_id, be.amount, pm.payment_token, pm.sequence_id, pm.provider
  FROM billing_events be
  JOIN product_sets ps ON ps.id = be.product_set_id AND ps.status = 'active'
  LEFT JOIN payment_methods pm ON pm.member_id = be.member_id AND pm.gym_id = be.gym_id
 WHERE be.billing_date <= <today>
   AND (be.is_scheduled = 1 OR be.event_type = 'failed_billing')
```

Only an **Active** set's events are executed (a Draft or a Pending Payment version bills
nothing), and a `failed_billing` event is selected again for its retry. The stored card is a
LEFT JOIN: an event with no card is not skipped silently — it stays scheduled and past due,
which blocks the next ProductSet edit (the editing lock) until a card or a cash payment
resolves it.

Before the loop the run resolves `charge_types.code = 'membership_fee'` and **fails the
whole run** (`500`, log row closed as `failed`) if it is missing — since migration 195 made
`payment_requests.charge_type_id` nullable, that lookup is the only thing left standing
between a broken install and charges recorded with no charge type.

### B4. Pricing

**Nothing is priced at run time.** The event's persisted `amount` is what the provider is
asked for (`toMinorUnits()` at the boundary). The amount was computed when the version was
committed, by the same engine every screen reads — `computeBillingSimulation()` over the
version's own frozen rows (`loadProductSetSimulationAssignment()`), which prices the
Membership Fee through `resolveMembershipFee()` (`api/src/domain/billingSimulation.ts`), the
**one** implementation of "what does the Membership Fee cost on this date", shared with the
Billing Simulation, `GET /me/membership` and every staff screen — and persisted with its
`billing_event_lines`. So what the run charges cannot drift from what the member was shown,
and a change of configuration has to **replace** the event before it is due
(`replaceFutureScheduledEvents()`), never re-price it afterwards.

Everything the resolver decides — the Billing & Duration cycle (#1130), the Pre-paid
Duration charged on the first of its periods (#946), an applied Promotion's Membership Fee
Benefit, the Personal Membership Fee Benefit — is therefore in the persisted amount, and a
zero amount is a cycle the contract waives.

**Membership Fee scope (#2834).** A plan snapshot's `membership_fee_scope` decides how many
fees a cycle owes: `per_family` (the default) one per assignment, `per_member` one per
beneficiary of that snapshot (`plan_snapshot_beneficiaries`, never fewer than one). The engine
multiplies the Membership Fee line by that count (`membershipFeeUnits`) after
`resolveMembershipFee()` has priced one fee, so every discount, Promotion and Billing & Duration
rule applies to each fee alike; no other path multiplies it.
Displays (stage 2) quote one fee each: the Assigned Plan card draws one fee row per fee owed
(*Family* for `per_family`, one per beneficiary for `per_member`), and the Members App names the
scope and the count beside one fee's price; neither multiplies anything.

**A Direct Discount per Membership Fee line (#2945, migration 429).** On a `per_member` snapshot
each beneficiary row may carry its own `fee_direct_discount_percent`: NULL (every row before the
ticket) follows the assignment's Personal Membership Fee Benefit (#772), a percentage replaces it
for that one fee, and `0` is no discount. `domain/feeMemberDiscounts.ts` is the rule; the engine's
Membership Fee line then prices each fee unit with its own benefit (`unitAmounts`) and charges
their sum, so a governing Promotion and the plan's durations apply to every fee as before and only
the last, personal step differs. With no own discount the line is the pre-#2945 arithmetic to the
cent. The value is written by `PUT /user-memberships/:id/fee-benefit` with `member_discounts`
(a Draft directly, a running plan through a new version like every other edit) and is copied with
the beneficiary row when a snapshot is copied. A `per_family` plan has one fee and keeps the
shared benefit alone.

### B4b. When obligations fall: the billing calendar (#2125 M5c)

Decided by Oscar on 2026-11-11 (Option B on #2125). A schedule is anchored on its
cadence's calendar grid, never on a start date: **monthly** on the 1st, **every 4 weeks**
on the 28-day grid anchored on Monday 2026-11-02, **weekly** on Mondays, **yearly** on the
obligation's own anniversary (any other stored cadence keeps its own date too).
`calendarAnchorOnOrBefore()` (`api/src/domain/calendarSchedule.ts`) is the one rule, applied
by `ensureSchedule()` and `allocateSchedule()` to every new schedule.

- **A plan starting off the grid** (`alignTo`, #2125 stage 8's mechanism) is charged, on its
  start date, the stretch to the next grid date prorated by the existing proration rule
  (`prorate()`: monthly price ÷ the days of its start month × days, #3280) **plus its whole Pre-paid Duration**; its Billing &
  Duration (free, pre-paid, paid, bonus) is counted from that next grid date, so the stretch
  consumes no period, and regular billing starts on the grid. A plan starting on a grid date
  is not prorated. Example: €31/month, 3 pre-paid, starting 17 Nov → €14.47 (14 of 30 days)
  + €93 on 17 Nov, nothing on 1 Dec, 1 Jan or 1 Feb, €31 from 1 Mar.
- **A plan added beside another plan follows its own cadence's calendar** (#3280). The plan's
  schedule is chosen by `allocatePlanSchedule()` (`api/product-set-configuration.ts`): the owner's
  `plan` schedule, or any other schedule of the same cadence, is joined only when it bills on that
  cadence's calendar (`billsOnOwnCalendar()`); a plan schedule opened on its start date before the
  calendar (the 7th) is not joined, and the new plan opens a schedule of its own on the grid. Its
  included Products on the plan's cadence bill on that plan's schedule, those on another cadence on
  their own calendar (the 28-day grid for 4-weekly). The established plan, its schedule and its
  Billing Events are not moved. A version re-snapshotting the plan it already holds keeps its
  schedule.
- **A monthly recurring Product's first stretch** (#3279) is prorated over the actual length of
  the month its own start date falls in (`prorate(…, { calendarMonth: true })`, passed only by
  `buildServiceStream()`): started 23 Nov 2026 → 8 of 30 days, 21 Feb 2026 → 8 of 28, 21 Feb
  2024 → 9 of 29. Since #3280 the plan's own fee above and a Product the plan includes divide by
  the same month length; weekly (7), 4-weekly (28) and yearly (never prorated) are unchanged.
- **A recurring Product added beside a plan that starts later** (#3167) starts today, on its own:
  the line's `starts_at` is today and the plan keeps its start date. Its first stretch (prorated
  to the next date of the schedule it joins, a whole year for a yearly Product) is due now, so the
  first version's initial payment carries it beside the plan's first cycle and is dated today; the
  schedule's later dates are scheduled obligations, and the stretch already paid is never
  generated again. Example: plan from 15 Dec, €31/month Product added 22 Nov → €9 for 22–30 Nov
  plus the plan's first cycle today, €31 on 1 Dec.
- **Existing schedules** are moved by `npm run schedules:realign`
  (`api/src/api/schedule-realignment.ts`, dry run unless `--execute`, one transaction per
  chain, run from the VPS as `node dist/scripts/realign-billing-schedules.js`): each
  off-grid anchor moves to the grid date on or before it, its future obligations with no
  `payment_requests` row are deleted and regenerated from the Active version by
  `materialiseScheduledEvents()`, and a future obligation that already has an attempt is
  **kept and listed**. No transition proration, credit or refund; past events, attempts and
  receipts are untouched; a second run changes nothing.
- **One schedule per cadence in a chain** (#2125 M5c-2, Oscar's §7). Two schedules of one
  chain are the same schedule when they have the same cadence and, for a grid cadence, any
  anchor (a yearly one only on the same anniversary): `domain/scheduleConsolidation.ts`.
  The same script folds them into one (`consolidateChainSchedules()`), into the `plan`
  schedule when the group holds it, else the oldest. Every snapshot line moves to it; each
  event of the merged schedule is **moved** unchanged when the target has none for its
  period, **regenerated** once when both are untouched future obligations (both deleted, the
  generator writes the date again with the lines of both), and **kept** on its own schedule
  and listed when either has history (past, attempted, paid) — never merged, deleted or
  duplicated. A merged schedule is deleted once no event references it. Going forward, a
  plan added to a chain that already bills a schedule of the plan's cadence adopts that
  schedule (`adoptScheduleAsPlan()`) instead of opening a second one.
- **A schedule is the owner's** (#2125 M5c-3, migration 396). `product_set_schedules`
  carries `owner_member_id` and is unique on `(owner_member_id, schedule_key)`; every reader
  finds a Product Set's schedules through its owner (`scheduleOwnerOfSetSql()`,
  `domain/scheduleOwner.ts`), so an owner who starts a new chain (possible only once their
  previous chain has no Active or in-flight version) bills on the schedule they already had
  when it is the same schedule. When it is not (another cadence, another yearly
  anniversary), `ensureSchedule()` re-keys the old one `<key>-<id>`, untouched, and opens a
  new one. Since M5d-2 (migration 400) `product_sets.root_product_set_id` is dropped and the
  schedule records the Product Set that *opened* it (`opened_by_product_set_id`, backfilled
  from the old root): the two writers that move a first Product Set's schedule (its start
  date, its cadence) move only one that set opened, so a later Product Set never moves a
  schedule an earlier one opened, and `ensureSchedule()`'s "same chain" test is an opener in
  the set's `previous_product_set_id` history. The migration moves no event or
  anchor; it re-keys an owner's duplicate keys (the live chain's keeps the key). The realign
  script now runs per owner and consolidates schedules of one identity across the owner's
  chains with the M5c-2 rules.
- **Done since**: the `product_sets` version columns (`version` in M5d-1, `root_product_set_id` in M5d-2).
- **Known gap**: the per-date pricers (`priceMembershipFeeOn()`, used by My Membership's
  current fee) still count Billing & Duration from the plan's own start, so for an aligned
  plan with a configured duration they may show a different period status than the
  persisted obligations, which are the engine's.

### B5. Outcomes

Per due event, under the event's row lock, exactly one of these:

| Outcome | Provider called | `billing_events` | `payment_requests` |
|---|---|---|---|
| **Refused by the charge guard** (an earlier attempt settled, is in flight, has an unknown outcome or was refunded) | no | untouched | untouched; logged for reconciliation |
| **Already attempted today**, or `MAX_FAILED_DAYS` (2) failed days reached | no | untouched | untouched |
| **Waived** (`amount = 0`) | no | `is_scheduled = 0`, `event_type = 'waived_billing'` | one `completed` row, `method 'waive'` |
| **No stored card** | no | untouched — stays scheduled, past due | nothing attempted |
| **Success** | yes | `is_scheduled = 0`, `event_type = 'recurring_payment'` | the attempt row, written **before** the call, closed `completed` with the raw `provider_status` (NULL when the answer named none, #3289) |
| **Rejected** | yes, declined | `event_type = 'failed_billing'` | the attempt closed `failed`, with `failure_code`/`failure_message` and the raw status |
| **In flight** (`PENDING_PROCESSING`, …) | yes | unchanged | the attempt stays `pending` with the raw status — the webhook settles it |
| **Provider error** (threw / never answered) | attempted | unchanged | the attempt stays `pending` with **no** provider status: an unknown outcome, never a failure |

Counters returned: `{ processed, succeeded, failed, waived, paused, receipts_issued,
invoices_issued, invoices_failed, scheduled_events }`. The first four are also written to
`billing_run_log`; the rest are reported only — a pause is explicable from its audit row, and a
receipt or invoice that failed to auto-issue is not a failed run.

**Automatic simplified invoices (#2648 stage 6).** After the charges, the run issues the
simplified invoice of every Billing Event generated from a schedule (`schedule_id IS NOT NULL`)
whose billing date has come — within the last `AUTO_INVOICE_CATCH_UP_DAYS` (7) days, at most
`AUTO_INVOICE_BATCH_SIZE` (500) per run — that is not cancelled, carries an amount and holds no
issued invoice yet, **whether or not it was paid** (`issueDueSimplifiedInvoices()` in
`api/src/api/billing-invoices.ts`, over `shouldAutoIssueSimplified()` in
`domain/billingInvoice.ts`). An unpaid one gets its not-paid representation; when it is paid
later, the existing invoice gains its paid representation and its `payment_status` moves to
`paid`, keeping its number and issue date. Every other event (a checkout's initial payment, a
purchase, a manual append) is issued its simplified invoice **when it is paid**, from the same
hook (`generatePaidRepresentations()`: the webhook / read-back settle, staff Pay Cash / Pay
Card, and both cash `record-payment` routes). An event that already holds an invoice of either
type gets none, so a transaction is never invoiced twice. Nothing is issued without the private
bucket. The VERI*FACTU Alta record is written with each invoice exactly as for a staff-issued one;
an event whose issue is refused (e.g. an invalid issuer NIF) is logged, counted in
`invoices_failed` and retried by the next run while it is inside the window.

**A complete invoice replaces the simplified one (#2648 stage 7).** A complete invoice
requested for an event that already holds a standing simplified invoice (issued, not
rectifying, not rectified, not already replaced, its VERI*FACTU record not cancelled —
`replacementTarget()`) is issued with `invoices.replaces_invoice_id` naming it (migration 423,
UNIQUE), and its Alta record is **F3** with `FacturasSustituidas`. The simplified invoice is
never edited; the GET derives `replaced_by_invoice_id`, the replaced invoice gets no further
representation, and it cannot be rectified or have its record cancelled — the complete invoice
is the one that stands and is corrected. Decisions taken: the oldest standing simplified invoice
is replaced; the link is stored with VeriFactu off too; a simplified invoice already rectified or
cancelled no longer stands, so a complete invoice for that event is an ordinary F1.

A settled charge also allocates a receipt number, **after** the charge transaction has
committed and in one of its own, with any failure logged and swallowed (see
[Receipts](#receipts)).

### B6. Dunning — a rejection escalates, it does not repeat (#785, on the event since #1325 PR 3)

- One attempt per UTC day on the same Billing Event: a rejection on a date the event was
  already attempted on is not retried, so the retry is the **next run day** — which is also
  why #781's 10:00 attempt becomes the day's real run whenever the 06:00 one crashed.
- After `MAX_FAILED_DAYS = 2` distinct failed days the automatic retries stop, and the
  assignment the ProductSet projects is **paused**: `pauseAfterFailedDays()` runs inside the
  transaction that closes the failed attempt, decides from the attempt rows under the lock
  (never from a stored counter — `user_memberships.failed_attempts` / `last_failed_at` are
  dropped by migration 252) and writes `recordStatusChange(… 'active' → 'paused', source
  'system')`, which since A4 is an **audit row** (`user_membership` / `status_change`),
  not a ledger row.
- Only a **provider rejection** counts. An unknown outcome (the provider threw, timed out or
  answered in flight) leaves an attempt with no definite status, which the charge guard then
  refuses to charge again until it is reconciled; a missing card attempts nothing.
- The surfaces that still show the pair (`failed_attempts`, `last_failed_at` on an assignment)
  derive it from the ledger: `domain/derivedBilling.ts` counts the failed provider attempts of
  the latest unresolved failed event by distinct UTC date.
- Reactivation stays **explicit**: settling the event never flips `paused → active`; staff use
  `POST /user-memberships/:id/reactivate`.

### B7. Failure handling by the staff (#640)

There is **no automatic retry inside a run**. The two actions live on a failed Billing
Event and are implemented in `api/src/domain/billingEventPayments.ts`:

| | `POST /payments/billing-events/:id/retry` | `POST /payments/billing-events/:id/manual-payment` |
|---|---|---|
| Gate | `requireModuleWrite('PAYMENTS')` | same |
| Provider | up to **2** sequential `executeRecurring()` calls | none |
| Writes | one `payment_requests` row per attempt (`source 'retry'`, incrementing `attempt`) | one `completed` row (`source 'manual'`, `provider 'manual'`) |
| On failure | both rejected ⇒ the assignment is paused via `recordStatusChange` | n/a |
| On success | `settleCycleAfterPayment()` — advances `next_billing_date` (only while it is today or earlier) **and** clears the dunning pair, in one transaction | same |

Both are refused unless `deriveBillingEventStatus()` says `failed`
(`isPaymentActionable()`), and both **never append a second Billing Event** — a Billing
Event is the charge, a `payment_requests` row is an attempt to settle it. That is why a
`failed_billing` later settled this way reads as `paid` and becomes receipt-able without a
special case.

Nothing notifies the member of a failed internal charge (decided on #779: staff-only,
in-app only — no email, no Slack).

#### Failed payments awaiting action (#779)

The staff's to-do list is the Billing Events list filtered by `failed`. A Billing Event is
**awaiting action** while `deriveBillingEventStatus()` says `failed` (`isAwaitingAction()`
in `domain/billingEventStatus.ts`), and one of the two actions above clears it by appending
a `completed` transaction. There is no status column.

| Surface | What it shows |
|---|---|
| `GET /payments/billing-events/attention` | `{ count, oldest_created_at }` (`loadFailedPaymentsAttention()` in `api/src/api/payments.ts`) |
| Sidebar | A red count badge next to **Payments** and **Billing Events**, hidden at zero, polled every 60 s while that entry is visible |
| Payments dashboard | A *Failed Payments Awaiting Action* card with the oldest failure's date (`awaiting_action_count` / `awaiting_action_oldest_at` on the summary) — all-time, unlike the monthly cards |
| Both link to | `payments/billing-events?status=failed&order=asc`: the list is the queue, oldest first |

> **Decisions (2026-09-27, #779)** — change them here if they turn out wrong:
> - **Count events, not memberships.** The badge then matches the row count of the list it
>   opens. Since #785 one assignment contributes at most two before the run pauses it.
> - **Recurring charges only.** A rejected or expired *first* payment writes no Billing
>   Event (A5 inserts `payment_recorded` only on `completed`), so it is not counted, and
>   the member usually retries it themselves. Surfacing failed checkouts would be its own
>   ticket.
> - **No extra role gate.** PAYMENTS read access sees the count, and the actions stay behind
>   `requireModuleWrite('PAYMENTS')`.
> - **Poll every 60 s.** The number changes about once a night.

#### Cancel and Refund (#2480)

| | `POST …/:id/cancel` | `POST …/:id/refund` |
|---|---|---|
| Gate | `requireModuleWrite('PAYMENTS')` | `requireRole('admin')` + flag `payments.billing_events.refund` + PAYMENTS write |
| Offered when | derived status `pending` (`can_cancel`) | money collected (`isPaymentCollected()`, cancelled or not, #2533) with refundable balance (`can_refund`) |
| Writes | `billing_events.cancelled_at`/`cancelled_by`; open attempts → `expired` | a new `payment_requests` row, `transaction_type 'refund'`, `refund_of_payment_request_id` → the collected attempt, `billing_event_id` NULL; `payment_refund_lines` for a line refund |
| Method | — | the original payment's own (`refundMethodFor()`, #2797): never chosen, a request naming another is a 400 |
| Provider | none | Cash / Card terminal: none. Monei: `refundPayment()` → `POST /v1/payments/{id}/refund` with the amount in cents, **after** the refund row is committed |
| Refused | not pending, already cancelled (409), a submitted attempt with no outcome (409) | nothing collected / nothing left (409), a provider payment with no `provider_ref` (409), invalid amount or lines, a method other than the original payment's (400) |

A refund's money rules: collected = the latest completed `payment` attempt with method
`provider`/`cash`/`card_terminal`; refunded = completed **and pending** refunds (a pending
Monei refund reserves its amount until reconciled); a failed refund releases it. A Monei
answer of `REFUNDED`/`PARTIALLY_REFUNDED` completes the row (with `provider_status` and
`provider_refund_ref`); an HTTP 4xx fails it; a transport error leaves it pending. The
event's displayed payment status reads `refunded` / `partially_refunded` from completed
refunds. Nothing else moves: the original attempt, the ledger row, its lines, a receipt
or invoice, the attempt counter and every contracted item stay as they were (since #3298 stage 3 a
refund issues a *new* rectifying invoice, below; since stage 4 a partial one too).

**A refunded event shows it in its status** (#2480 follow-up, 2026-11-24). The Billing Events list and
detail report a paid event as `partially_refunded` or `refunded` from its completed refunds
(`displayBillingEventStatus()`); the status filter takes both values. It is display only:
`deriveBillingEventStatus()` still answers `paid`, so receipts, invoices, dashboards, the member's
Payment Status and the refund rules see the money as collected, a cancelled event stays `cancelled`,
and a pending or failed refund changes nothing.

**A pending Monei refund is settled later from Monei's own record** (#2480 follow-up).
`POST /billing/cleanup` runs `reconcilePendingProviderRefunds()`
(`api/src/api/billing-event-refunds.ts`): for each payment with a provider refund pending for
more than 10 minutes, it asks Monei how much of that payment it has refunded in total
(`getRefundedAmount()`, the payment's `refundedAmount`) and `allocateProviderRefunds()`
(`domain/billingEventRefund.ts`) decides, oldest first, which pending refunds that covers beyond
the completed ones: a covered refund is completed (with its Refund Receipt, #2935), one still
uncovered after `PENDING_REFUND_FAIL_AFTER_HOURS` (24) is failed and its amount released, and
the rest stay pending. A payment Monei cannot be asked about, or whose answer gives no total,
is left for the next run. The cleanup response reports `refunds_completed` / `refunds_failed`.

> **Decisions (#2480)** — change them here if they turn out wrong:
> - **A refund carries no `billing_event_id`.** It reaches the event through the attempt it
>   refunds, so the ~60 readers of "the event's latest attempt" need no change.
> - **Cancel expires open attempts** rather than leaving them pending, so a stale link cannot
>   pay a cancelled event. ~~A payment that still completes reads `paid` (money wins).~~
>   Reversed by #2533 stage 2, below.
> - **Cancelling a first payment leaves the membership `pending_payment`** — cancelling the
>   charge is not cancelling the plan.
> - ~~**Card terminal is a manual refund method** beside Cash; Monei is offered only for a
>   provider payment with a `provider_ref`.~~ Reversed by #2797, below.
> - **A pending Monei refund is not reconciled automatically** yet; it stays reserved.

#### Refund Receipts (#2935, migration 426)

Every refund transaction that **completes** is documented by a Refund Receipt
(`refund_receipts`, one row per refund `payment_requests` row, `UNIQUE (payment_request_id)`):
a manual refund (cash, card terminal) gets it inside the transaction that records the refund;
a Monei refund gets it right after the provider answers `REFUNDED`/`PARTIALLY_REFUNDED`, in a
transaction of its own whose failure is logged and never undoes the refund (#787's reasoning).
A pending or failed refund gets none, and each partial refund gets its own. The number is its
own gapless per-gym, per-year series, `R-YYYY-NNNN` (`refund_receipt_sequences`, never
`receipt_sequences`), allocated only by `issueRefundReceipt()` (`api/src/api/refund-receipts.ts`)
under the refund row's lock. The original receipt number, its PDF and every invoice are not
touched.

**Every completed refund issues a rectifying invoice of the invoice it refunds, by differences**
(#3298 stages 3–4, migration 476). Once a refund is `completed`, `issueRefundRectification()`
(`api/src/api/billing-invoices.ts`) rectifies the event's standing invoice through
`rectifyInvoiceInTx()`, the manual rectify route's own writer: its own `R-` number, R5 for a
simplified invoice and R1 for a complete one (TipoRectificativa `I`), its VERI*FACTU Alta in the
same transaction, and `invoices.refund_payment_request_id` naming the refund. The rectifying
invoice states **that refund's own figures**, negated (`loadDocumentFigures()` in
`api/src/api/invoice-figures.ts`, the one source of the PDF, the Alta's totals and its Desglose,
over the pure `refundRectificationLines()`): a Selected Line Items refund the lines it named at
the amounts it returned on them; a full or ad-hoc refund its amount spread over the event's lines
in proportion (largest remainder, to the cent; a full refund of the whole event states its lines
unchanged), each line keeping its own rate and a stored net scaled with it. So a partial refund
gets its own rectification, and a later one another against the same invoice, until their
amounts reach the invoice's total (`rectifiableRemainderCents()`). Staff's manual rectification
still cancels an invoice in full and is refused (`409 Invoice already rectified`) once anything
rectified it; a manual one leaves nothing for a later refund to rectify. The Refund Receipt (the
proof the money went back) stays its own record; the Admin links the two (*For refund …* /
*Rectified in …*) and lists every *Rectified by* on the original. Which invoice is
`refundRectificationTarget()`'s: issued, not rectifying, not cancelled in full, not rectified up
to its total, not replaced (a complete invoice that replaced the simplified one is the one
rectified) and not cancelled by an Anulación. It runs after the refund commits on all three
completion paths (manual, Monei's answer, the cleanup's reconciliation), best-effort: a failure
is logged and staff can still rectify by hand. Decisions: the reason printed is
`Refund <refund receipt number>`; a simplified invoice partly rectified is not replaced by a
later complete invoice (`replacementTarget()` already skips a rectified one, so that complete
invoice is an F1), unchanged from before.

The PDF ("JUSTIFICANTE DE DEVOLUCIÓN / REFUND RECEIPT", `lib/refund-receipt-pdf.ts`) prints the
gym's legal name, NIF and fiscal address; the payer's name and tax id (the event's issued full
invoice's customer data, else the member's NIF/NIE); the refund's date and time, amount,
currency, method, reference (`provider_refund_ref`, else the transaction id) and refunded
lines; and the original receipt number, payment date, amount and Billing Event. It is rendered
once into the private bucket (`refund_receipts.pdf_key`, `buildRefundReceiptKey()`) and served
by `GET /payments/refund-receipts/:id`, which never issues one. The Billing Events list reports
`refund_receipts` per event (the ⋮ menu's *View Refund Receipt* entries) and each refund
transaction its `refund_receipt_number`.

> **Decisions (#2935)** — change them here if they turn out wrong:
> - **No backfill**: refunds completed before migration 426 have no Refund Receipt.
> - **The refund reason is the refunded lines**: a refund records no free-text reason, so a
>   Selected Line Items refund prints its lines and any other prints none.
> - **No logo**: the receipt and invoice PDFs draw none today; the Refund Receipt follows them.
> - **The customer is the payer** (`payer_member_id`, else the member), the one the money
>   went back to.

#### A refund goes back through the original payment method (#2797)

`refundMethodFor()` (`domain/billingEventRefund.ts`) answers the one method a collected
payment is refunded through: `provider` for a payment taken through the provider (MONEI's
refund on that same payment, `provider_ref`), `cash` for a cash payment, `card_terminal`
for one taken on an external terminal. The two manual ones call no provider: the row
records that the gym returned the money itself. `GET …/refund-options` reports it as
`method: { code, name, manual }` (the name is the attempt's own `payment_method_name`
snapshot, #2451) and the Refund modal shows it read-only; the request body names no method.

> **Decisions (#2797)** — change them here if they turn out wrong:
> - **A request that names another method is a 400**, not silently overridden, so an old
>   client cannot believe it refunded in cash what went back to a card.
> - **A provider payment with no `provider_ref` cannot be refunded** (`409`, on the options
>   read and on the refund). There is no transaction to refund, and handing it back through
>   another method is what the ticket forbids. Before #2797 it was offered Cash / Card terminal.
> - **One original payment per event.** The collected attempt is still the latest completed
>   one (the charge guard allows a single settled attempt per event), so every refund of an
>   event names the same `refund_of_payment_request_id` and there is no mix of methods to resolve.

#### Provider status comes only from the provider (#3289)

`payment_requests.status` is the application's own lifecycle (`pending`, `completed`,
`failed`, `expired`) and is **not** a provider status. `payment_requests.provider_status`
(nullable, no default) holds only a status the provider itself returned — a provider API
response that names one (`executeRecurring()`), a signature-checked webhook, or an
identity-checked read-back (`getPaymentStatus()`) — stored through
`normaliseProviderStatus()` (trimmed, uppercased). Nothing else writes it: creating a request
or a hosted checkout, picking a payment method, cash / card terminal / waive, a Product Set
moving to `pending_payment`, a member returning from or cancelling the hosted page, or a
provider answer that carries no status. An answer with no status still decides its outcome
from the provider's `success` flag, exactly as before; it simply stores nothing. A later
answer with no status never erases one already received (`COALESCE(?, provider_status)`).

The normalized payment status is `normalizePaymentStatus(provider_status)` and nothing else:
`NULL` provider status → `NULL` normalized status (rendered `—`), with no fallback to the
request's or the Billing Event's internal status. Since #3352 there is no overlay at all: a
refund is the Billing Event's own `status` (`displayBillingEventStatus()`, `refunded` /
`partially_refunded`, on the staff list and Details and on a purchase's event), and the
normalized payment status of a refunded payment stays what the provider reported for the
payment (`completed` for `SUCCEEDED`). A Member's aggregated Payment
Status (#2574, `memberPaymentStatusSql()`) is a different, documented read and keeps its
fallback to the attempt's internal status.

#### A cancelled Billing Event stays cancelled (#2533 stage 2)

A Billing Event carries three independent answers: its **status** (administrative,
derived by `deriveBillingEventStatus()`), the latest attempt's **payment status**
(`payment_requests.provider_status`, the provider's own value verbatim) and its
**normalized payment status** (`normalizePaymentStatus()`). The normal lifecycle is
unchanged — `pending` → `paid` on a completed attempt, → `failed` on a rejected one — but
`cancelled_at` outranks it: a cancelled event reads `cancelled` whatever arrives after it.

| After Cancel the provider answers… | `status` | `payment_status` | `normalized_payment_status` | Side effects |
|---|---|---|---|---|
| `SUCCEEDED` | `cancelled` | `SUCCEEDED` | `completed` | the attempt is completed; **no** ProductSet activation, assignment commit or purchase completion (`settleInTransaction()` logs a warning for refund review) |
| `FAILED` | `cancelled` | `FAILED` | `failed` | the attempt is failed; not in the failed-payments queue |

Readers that ask about money ask the payment result, not the status:
`isPaymentCollected()` decides receipt eligibility (`isReceiptableEvent()`) and `can_refund`,
so money collected on a cancelled event is receiptable and refundable. Readers that ask
about obligations ignore a cancelled event: `paymentActionsFor()` offers nothing,
`guardActionable()` refuses Retry / Manual payment / Waive with 409, the failed queue, Home,
the Payments dashboard and the member's Payment Status keep their `cancelled_at IS NULL`
filter. No new attempt is raised on a cancelled initial event: a staff payment link, the
member's Pay now and `POST /user-memberships/:id/record-payment` answer
`409 billing_event_cancelled` (`openInitialEventForAssignment()` reports `cancelled`).

> **#3332**: the `recorded` fallback is gone. A Billing Event with no attempt whose type records
> no payment (`adjustment`, the retired `status_changed`, a `card_verification`) has **no** status
> (`deriveBillingEventStatus()` answers `null`, the Admin shows `—`, the member no pill), and a
> `waived_billing` with no attempt reads **`waived`** — never `paid`, so `isPaymentCollected()`,
> receipts and refunds still see no money. `GET /payments/billing-events` never lists a
> `status_changed` row or an attempt-less `card_verification`; `?status=recorded` is a 400.

> **Decisions (#2533 stage 2)** — change them here if they turn out wrong:
> - **The vocabulary is unchanged** (`paid | failed | pending | scheduled | recorded | cancelled`);
>   the ticket's `pending_payment`/`canceled` are the existing `pending`/`cancelled`, and
>   `normalized_payment_status` stays derived on read from the stored raw status (stage 1),
>   not a new column.
> - **A completed payment on a cancelled event activates nothing** (ProductSet, assignment,
>   one-time purchase). The card the payment stored is still stored: it is the payer's fact,
>   not a status.
> - **A failed attempt on a cancelled event is not in the failed queue**: the queue is the
>   staff's work list of obligations, and a cancelled event is none.
> - **The paid-only dashboard counts keep excluding cancelled events**; the money stays visible
>   on the event (normalized `completed`) and in its refund state.

### B8. `POST /billing/cleanup`

`payment_requests` carries **two** deadlines and they are not interchangeable (#789,
`api/src/domain/paymentRequestExpiry.ts`). `page_token_expires` (creation + 10 minutes)
bounds how long the checkout *link* may be **opened**; how long the member may then take to
pay through it is a different, much longer question — Card Input, a 3DS redirect, and Monei
retrying its webhook after a transient 5xx of ours.

What tells the two apart is `page_token` itself: §A4's page load is the only writer that
clears it on a row still `pending`, so a `NULL` token *is* the record that someone opened the
page. Cleanup therefore runs two statements:

```sql
-- Never opened: expires with its token, because no payment can be in flight.
UPDATE payment_requests SET status = 'expired', page_token = NULL
WHERE status = 'pending' AND page_token IS NOT NULL
  AND page_token_expires < UTC_TIMESTAMP()

-- Opened: written off only once the provider has plainly never resolved it.
UPDATE payment_requests SET status = 'expired'
WHERE status = 'pending' AND page_token IS NULL
  AND page_token_expires < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
```

The grace period is `abandonedRequestHours()` — `PAYMENT_REQUEST_ABANDONED_HOURS`, default
24, **floored at 1** so a deployment that sets `0` cannot reintroduce a deadline shorter than
a checkout takes. It is added in SQL, keeping the comparison in the same UTC clock
`page_token_expires` was written against.

**Before writing an opened request off, cleanup asks MONEI** (#2087,
`reconcileAbandonedRequests()` in `api/src/api/payment-settlement.ts`). The opened rows past the
window that carry a `provider_ref` are read back, at most `RECONCILE_BATCH_SIZE` (200) per run:

- MONEI says it succeeded → settled as completed (`via: 'cleanup'`), plan activated, never
  expired — this is the member who paid while the webhook was lost, whom the old statement
  expired and `expirePendingPayments()` then returned to Draft, deleting the request and the
  Billing Event;
- MONEI says it failed / expired / was cancelled → settled with that outcome;
- MONEI still reports no outcome (or names another order) → expired by the statement above,
  as before;
- MONEI cannot be reached, or the row is past the batch → left `pending` for the next run.

The second statement therefore only expires rows with no `provider_ref` or rows MONEI was asked
about and still reports pending. `reconciled` counts the rows MONEI's answer settled.

> **Decisions (2026-10-25, #2087)**: at most 200 lookups per run; a request MONEI still reports
> pending after the window is expired as before; an unreachable MONEI leaves the row for the
> next run (it runs twice a day, #781).

Answers `{ expired, expired_unopened, expired_abandoned, reconciled, purchases_cancelled }`. **`expired` stays the total**,
because `.github/workflows/billing-run.yml` parses that field by name (#778); the two
components are reported beside it, not instead of it. It runs twice a day because the
workflow does (#781), which is harmless: expiring stale pending requests is idempotent.

> Until #789 this was one statement on the ten-minute deadline, which expired requests
> members were part-way through paying — and §A5's `pr.status !== 'pending'` guard then
> skipped the completed webhook, so the money moved and Gymdesk kept no record of it: no
> `payment_methods` row, no `next_billing_date`, and the member app still offering to pay.
> Do not collapse the two deadlines back into one, and do not add a shorter window that
> expires an opened request.

Since #1121 stage 2 it runs a third statement, and it is about `member_products` rather than
about money: every purchase still `pending_payment` whose payment request is no longer
pending becomes `cancelled` (`cancelAbandonedPurchases()`,
`api/src/api/me-products.ts`). The pending key is UNIQUE, so a purchase left pending by an
expired request or a `failed` webhook that never arrived would block that member from ever
buying the Product again. It is keyed on the **request's own status**, including the rows the
two statements above just expired, so there is no second definition of when an attempt is
over, and it is reported beside the totals rather than folded into `expired`.

---

### B9. The rolling window of future obligations (#3445)

Each recurring schedule of an Active Product Set keeps its next **two positive** obligations
persisted as Scheduled Billing Events. `materialiseScheduledEvents()` asks
`planScheduledEvents(…, { positiveOnly: true })`: a cycle that owes nothing (a free, Pre-paid or
fully discounted period) is never persisted and holds no slot, and the engine's horizon is
doubled (`MAX_WINDOW_SCAN_CYCLES` = 64 cycles at most, inside the engine's 36-month cap) until each
schedule has two positive dates or the contract has none left. Each schedule counts on its own, so a
yearly line and a four-weekly line keep two cycles each; lines sharing a schedule and a date stay one
event. A prorated first stretch is a stub, not a cycle, and is persisted beside the two (#2125 stage 9).

The window is filled on activation (`activateWithEvents()`, i.e. on payment confirmation or a free
commit) and replenished by `POST /billing/maintain-window` (`BILLING_INTERNAL_SECRET`,
`maintainBillingWindow()` in `api/src/api/billing-window-maintenance.ts`): every `active` set, one
transaction each under its row lock, the same writer, so an obligation already persisted for its
`(schedule, period)` — attempted, paid or not — is never touched, and `UNIQUE (schedule_id,
period_start)` is the backstop for a concurrent call. It charges nothing and writes no payment
request. It answers `{ run_date, product_sets_examined, product_sets_updated, events_created,
failures }`, and `500` when any set failed (the others are still done; a retry is safe). It claims
no run-log slot (it is idempotent) and records a `job_run_log` row as `billing_window_maintenance`.
It is fired daily at 05:23 UTC (and on demand, `workflow_dispatch`) by
`.github/workflows/billing-window-maintenance.yml` through the admin relay (#3444), a workflow of
its own so a maintenance failure never stops `billing-run.yml`'s charges or the reverse; a
`concurrency` group keeps two runs from overlapping, and a red run is retried by re-running it.
Its scheduled workflow is #3444.

## D. Product purchase (member, one-off)

A member buying a Product from the Members App (#1121 stage 2, §5/§6; Promotions on it
#1118) — self-service and final, no staff approval (the thread's `Q3`). It reuses §A's
infrastructure end to end and adds no second payment mechanism:

1. **`POST /me/products/:id/purchase`** (`api/src/api/me-products.ts`) reads the Product
   through `memberProductCatalogueSql()` — the very predicate that decided what the member
   was *shown* (stage 1), so a `staff_only`, inactive or deleted Product is a 404 here as
   surely as it is absent there. A member must not be able to buy what they cannot be shown.
2. It refuses, as a code the Members App translates: `recurring_not_supported` (stage 2 buys
   a **one-off**; `isRecurringFrequency()` decides, #550), `no_price`, and
   `purchase_pending` (409 — a checkout already in flight).
3. It charges the **quoted** figure: the VAT-inclusive `price_incl_tax` the catalogue
   showed, or — where the member applied a Promotion — that Promotion's own final price,
   through `toMinorUnits()` at the provider boundary. Nothing re-rates or divides it (a
   Sessions package is the price of the whole package, #942).
3b. **An applied Promotion (#1118 §5)** is named by the request as a `promotion_id` and
   nothing else: the route re-reads it through the very loader that produced the offer
   (`loadPromotionOffers()`, `api/src/api/member-product-promotions.ts`) and prices the
   charge from the answer, so a price named by the browser is ignored and a Promotion that
   expired, was switched off or was re-configured between the quote and the Buy answers
   `409 promotion_not_applicable` rather than charging a price the gym no longer offers.
   Which Promotions are offered at all is `api/src/domain/memberProductPromotion.ts`' one
   rule (the Promotion's own grant row for that Product — the thread's `Q4`, no second
   relation — `applies_to = 'product'`, inside its window, `only_applicable_for_new_members`
   through #927, and only where it prices the Product **lower than its own price and above
   nothing**).
4. One transaction writes the `payment_requests` row (`source = 'product_purchase'`,
   `user_membership_id` **NULL**, `consent_given_at` stamped — the member goes through the
   hosted page's consent), the `member_products` row (`pending_payment`, carrying the
   snapshot) and, where one was applied, the `member_product_promotions` row that freezes
   the Promotion (migration 229: its name, its `(action, value)` pair, its duration in
   billing cycles and both amounts). The member is handed the checkout URL. Tapping *Apply
   promotion* in the app persists nothing — §7 binds the snapshot to "the resulting
   purchase", so there is nothing for it to hang off before one exists.
5. **The hosted page** words it as a one-off: `GET /payment-page/token/:token` reports
   `purpose: 'product_purchase'` plus the snapshot's `itemName`, and the page's consent
   sentence says *Es un pago único* rather than the fee's "until you cancel your
   membership".
6. **§A5's webhook** settles it on its own branch: the request is completed, a
   `product_purchase` Billing Event is written with **no** ProductSet (money did
   arrive, so it belongs in the ledger the member's Payments card and the staff pages read),
   and the purchase becomes `active` with `purchased_at`. That branch deliberately stores
   **no card** (a one-off authorises one charge; #788 is where a card comes from), stamps
   **no** `next_billing_date` and clears **none** of #785's dunning counters — a rejected
   membership cycle is still owed after a member buys a locker. A `failed` or `expired`
   outcome cancels the purchase instead. The Billing Event carries `payment_requests.amount`,
   which is the **discounted** figure where a Promotion was applied — #1118 §14's "the
   resulting Billing Events must be generated using the Promotion snapshot", true by
   construction rather than by a second pricing path.
7. Idempotency (#1118 §10) is the webhook's existing "already processed, skipping" guard,
   `UNIQUE (payment_request_id)` and the purchase `UPDATE`'s own `status = 'pending_payment'`
   constraint — so a retried delivery completes one row and writes one Billing Event.
8. **Afterwards**, staff read the purchase and its frozen Promotion at
   `GET /members/:id/products` → the Member card's **Products & Services** section (#1118
   §11–§13). That read joins neither `products` nor `promotions`: every column on screen is
   the purchase's or the application's own snapshot, so a Promotion later edited from 50% to
   30% still reads 50% there.

**Not here yet**: a recurring Product. `Q3` asks for the system to "create or update the
billing event plan for such member", which is a second recurring schedule beside
`user_memberships.next_billing_date` and therefore a change to what the nightly run charges,
not a shop. Until that stage lands, a recurring Product is offered with **no Buy action at
all** (#1073: a control that cannot work is absent, never broken) — and a Periodic
Promotion grant's duration therefore has no purchase to apply to yet, which is why §6's
"duration in billing cycles" is reported on the offer and reads as nothing for the one-off
grants that *are* purchasable (the thread's `Q5`). A Promotion that prices a Product to
nothing is also not offered: this flow buys a Product by paying for it, and granting one for
free is a decision a ticket has to take.

### D2. Several standalone cart purchases, one payment (#2949 stage 4)

A one-time purchase can wait in the cart as an `in_cart` row no Product Set carries: written by
staff as a draft (#1657) or by the member through `POST /me/cart/purchases` (no Product Set
created). `startCartCheckout()` (`api/src/api/cart-checkout.ts`) pays all of them, or the
`purchase_ids` named, from `POST /me/cart/checkout` (the member; a family beneficiary gets
`403 family_owner_pays`) or `POST /members/:id/product-purchases/checkout` (staff):

1. The cart is read after the cart expiry (#2962, since #3274 the purchase's one clock, `expireCarts()`); empty → `409 cart_empty`, a named id not
   in it → `404 purchase_not_in_cart`, a zero total → `409 nothing_to_pay`.
2. The provider payment is created for the **sum of the frozen amounts** (each priced when it
   entered the cart; nothing is re-priced — the conservative default, as a cart Product Set's
   linked purchases are), converted once by `toMinorUnits()`.
3. One transaction: every purchase locked and re-checked (`409 cart_changed` otherwise), one
   `payment_requests` row (`source = 'product_purchase'`, the payer resolved as for any purchase),
   one `product_purchase` Billing Event (no ProductSet; named `Gym - Product` or
   `Gym - Compra dd/mm/yyyy`), one `billing_event_lines` row per purchase, each purchase
   `in_cart` → `pending_payment` and linked through its event junction. The charge type is the
   Products' own when they share one, else none.
4. The webhook's purchase branch completes **every** pending purchase the request reaches
   (`completeProductPurchase()`); a failure or expiry cancels every one, as before.

A purchase a cart Product Set carries is never selected: it is paid by that set's Save & Pay
(#2746).

### D3. A Product Set's Save & Pay pays the whole cart (#2949 stage 5)

A Product Set's initial charge (`initialCharge()`, so the *Review your changes* amount, Save & Pay
and every `/pay` method take the same figure) adds, beside the set's own lines and its linked
purchases, one line per **standalone `in_cart` purchase of the set's owner** at its frozen amount
(`cartPurchasesForCharge()`, `cartChargeLine()` in `api/src/api/cart-checkout.ts`), and lists them
in `InitialCharge.cartPurchases`. `ensureInitialEvent()` then **joins** exactly those to the set's
initial event (`joinCartPurchasesToEvent()`): each one is locked and re-checked (the owner's, still
standalone and `in_cart`, at the amount charged; `409 cart_changed` otherwise), moved to
`pending_payment` and linked through its `billing_event_{oneoff,session}_snapshots` junction. It is
**never** linked to the Product Set. So one Billing Event and one payment cover the plan, the
recurring Products, the set's own one-time purchases and the standalone ones.

From then on a joined purchase follows the set's checkout, found through the set's events
(`loadJoinedCartPurchases()`):

| The set's checkout | A joined purchase |
|---|---|
| paid (webhook, cash, card terminal) → `activate()` | `active`, with its purchase day and validity (`activateSetPurchases()`) |
| returned to Draft (`returnPendingToDraft()`) or deleted (`cancelInFlight()`) | back to `in_cart`, its event link removed (`releaseJoinedCartPurchases(…, 'in_cart')`) |
| cancelled and kept (`cancelPendingProductSet()`) | `cancelled`, link kept |

`cancelAbandonedPurchases()` skips a purchase whose request's event belongs to a Product Set, so
an expired set checkout returns it to the cart rather than cancelling it. A purchase added to the
cart after Save & Pay is not part of that checkout and stays `in_cart`. Not included, by default:
the Admin assignment card's own Save & Pay (`importAssignmentAsProductSet(…, { pending: true })`
moves the set to Pending Payment before its charge is computed) and the Members App plan choice's
`membership_fee` preview (`includeCart: false`).

**What the cart screens show (#2949 stage 6).** The member's set read (`GET /me/product-sets/:id`,
owner only) reports those purchases as `cart_purchases` (`cartPurchasesForCharge()`: every
standalone `in_cart` purchase while the set is in the cart, the joined ones while its checkout is in
flight), and the *Review your changes* `contracted_items` lists them as one-time Products for the
owner (or the family member they were bought for). Nothing is priced for either read. In the
Members App *Add to cart* writes a standalone purchase (`POST /me/cart/purchases`) and never opens a
Product Set; `apps/member/src/lib/memberCart.ts` decides the cart from the set view plus
`GET /me/cart/purchases`: with a Draft the standalone items join its card and its Save & Pay; with
none they are a cart of their own whose Pay is `POST /me/cart/checkout`; while a set's checkout is in
flight (or staff are still setting a Draft up), a purchase added since is a second card beside it,
paid on its own.

---

## C. Reference

### Data model

All five tables verified against a fully migrated MySQL 8.4 database.

**`payment_requests`** (migration 104) — one row per *attempt to move money*, or per card
verification. Not a ledger: it is the transaction table.

- `amount DECIMAL(10,2)` in **euros**, `currency CHAR(3) DEFAULT 'EUR'`.
- `charge_type_id` — **nullable** since migration 195 (a card verification bills nothing).
- `billing_event_id` — FK `ON DELETE SET NULL`; the link that makes an event's status
  derivable.
- `page_token CHAR(36)` UNIQUE + `page_token_expires` — the hosted page's single-use token.
  On a row still `pending`, `page_token IS NULL` means the page was opened.
- `status` ∈ `pending | completed | failed | expired` (`chk_payment_requests_status`).
- `source` ∈ `admin | customer | billing_run | retry | manual | card_update |
  product_purchase` (`chk_payment_requests_source`, widened by 111, 165, **195** and
  **228**).
- `user_membership_id` — **nullable** since migration 228 (#1121 stage 2): a member's
  product purchase belongs to the member, and under #956 they may hold no plan at all.
  Every reader LEFT JOINs the assignment. `billing_events` has no such column since
  migration 256 (#1325 PR 3d): an event's assignment is its ProductSet chain's
  (`domain/billingEventOwnership.ts`).
- `attempt` (default 1), `failure_code`, `failure_message`, `notes` — #640.
- `consent_given_at` (member's MIT consent), `created_by` / `modified_by` (plain-text actor, #1182; `initiated_by` and `modified_by_user_id` are frozen).

**`payment_methods`** (migration 103) — the stored card, `UNIQUE (gym_id, member_id,
provider)`. `payment_token` + `sequence_id` are the credentials that charge the member and
**never leave the API** (`describeStoredCard()`, `api/src/domain/storedCards.ts`).
`updated_at` (migration 195) is when the card *on file now* was stored; `created_at`'s
default was normalised to `UTC_TIMESTAMP()` in the same migration so the pair share one
clock.

**`billing_events`** (migration 008) — the append-only ledger **of the past only**. It has
no status column: an event's status is its latest linked transaction's, falling back to the
event type (`deriveBillingEventStatus()`, `api/src/domain/billingEventStatus.ts`).

- `name VARCHAR(255) NULL` (migration 428, #2940) — the event's generated name, written once by
  its writer through `api/src/api/billing-event-name.ts` over `domain/billingEventName.ts`
  (`Initial Engagement`, `<Gym> - <Month>`, `<Gym> - <Month> (dd/mm/yyyy)`, `<Gym> - <Item>`,
  `<Gym> - Compra dd/mm/yyyy`). Display only: nothing prices, settles or invoices from it, and
  an event written before it (or by a writer that names nothing: adjustments, manual appends,
  card verifications) holds NULL and is shown as before.
- `event_type` ∈ `charge_created | payment_recorded | status_changed | adjustment |
  recurring_payment | failed_billing | waived_billing | product_purchase | card_verification`
  — `billing_events_event_type_check`, current definition in **migration 247**.
  `status_changed` is history only: nothing writes it since #1325 PR 3 (migration 252 moved
  the existing rows into `audit_logs`), a transition is an audit row. A new type goes in **two** places: the writer
  *and* that CHECK, or the INSERT fails and takes the run's transaction with it.
- `source` ∈ `admin | system | employee | customer | provider`.
- `receipt_number` + `receipt_issued_at` — see [Receipts](#receipts).
- `previous_status`/`new_status` are the retired `status_changed` row's columns (unused now).

**Future rows are never persisted.** Three surfaces project the gym-wide future on read,
each pricing every projected date through the same resolver the run uses:

| Surface | File |
|---|---|
| `GET /payments/billing-events` — a rolling 5-date window per active assignment, `type: 'virtual'`, `status: 'scheduled'`, each amount priced for its own date | `api/src/api/payments.ts:310-395` |
| `GET /payments/dashboard/summary` — `scheduled_this_month` | `api/src/api/payments-dashboard.ts` |
| `GET /me/membership` — `upcoming_payments` | `api/src/api/me.ts:1453` |
| `GET /me/billing-event-forecast` — the member's own Billing Event Forecast, one group per future billing date (#1123) | `api/src/api/me-billing-forecast.ts` |

One further projection is scoped to one record rather than the gym:
`api/src/domain/planExampleTimeline.ts` projects a *Membership Plan's* own Example timeline
(#485, reshaped by #818 — one row per billing period of the Plan's cadence, each classified by
`classifyPlanDurationPeriod()`, and deliberately promotion-free). An Assigned Plan's own Billing Events view
(`api/src/domain/assignedPlanBillingEvents.ts`, #511 stage 3) is not one: since #854 it only
tags and filters the persisted `billing_events` ledger. Both are pure and unit-tested.

**`billing_run_log`** / **`recurring_booking_run_log`** (migration 193) — **histories**,
one row per run: `run_date DATE`, `status`, `started_at`, `finished_at`, and each job's own
counters (`processed, succeeded, failed, waived` / `processed, created, skipped, failed,
notified`). Both deliberately have **no `gym_id`** (migration 111's exception): a nightly
run is a system-wide job, not tenant data. `status` ∈ `in_progress | completed | failed`
(`chk_<table>_status`).

**`member_products`** (migration 228, #1121 stage 2) — one row per Product a **member**
bought from the Members App. A snapshot of what was bought (`product_name`,
`product_type`, `billing_frequency`, `units`, `amount` **VAT-inclusive**, `currency`,
`tax_rate_percent`) beside `product_id`, the link to the live Product — #635 §16's rule one
table over, so a Product renamed, repriced or retired afterwards moves nothing about a
purchase already made.

- `status` ∈ `pending_payment | active | cancelled` (`chk_mprod_status`). "Available" is
  the **absence** of a row; `cancelled` is where a purchase whose payment failed or expired
  goes, which is also what frees the key below so the member can try again.
- `pending_purchase_key` — a VIRTUAL generated column, UNIQUE, non-NULL only while the row
  is `pending_payment`: one checkout in flight per (member, Product), so a double-tapped
  Buy cannot produce two. An `active` purchase deliberately does **not** block a second
  one — nothing in `products` says an item may be bought once.
- `payment_request_id` UNIQUE (FK `ON DELETE SET NULL`) and `billing_event_id` — one
  purchase per payment, which is what makes the webhook idempotent.
- `created_by_name`/`created_by_type` — #799's actor snapshot; `member` for a self-service
  purchase.
- FK to `products` is **RESTRICT**: a purchase is the record of money that moved, so a
  Product may not be hard-deleted under it (the catalogue's own removal is a soft delete).
- `amount` is always **what was charged**. Where a Promotion was applied that is the
  discounted figure, and the regular price it was discounted from lives on the application
  below — so there is no second money column here and no "was it discounted?" flag.

**`member_product_promotions`** (migration 229, #1118) — the Promotion a member applied to a
purchase, frozen. The sibling of the three `user_membership_promotion_*_snapshot` tables and
for the same reason (#635 §16): `promotion_name`, `benefit_action`, `benefit_value`,
`duration_cycles` and both amounts (`regular_amount`, `final_amount`, VAT-inclusive) beside
`promotion_id`, the link to the live Promotion.

- `UNIQUE (member_product_id)` — **at most one Promotion per purchase**. §4/§5/§13 all speak
  of *the* Promotion on a Product, so the rule is the database's rather than the route's and
  a retry or a second caller cannot stack one.
- `chk_mprodp_action` / `chk_mprodp_value` mirror migration 203's **Promotion-side** pair (all five
  actions, the same value rule): an application is read in the Promotion's own option set,
  never a Plan's, or a `fixed_discount` would normalize away and the Admin would quote the
  full price for a line the member was promised at another one.
- `chk_mprodp_amounts` — both non-negative and `final_amount <= regular_amount`. It is
  deliberately a **superset** of the one writer's rule (an offer is only ever made where it
  prices the Product lower than its own price and above nothing), as is the action CHECK: the
  narrow rule lives in the loader, where it can change without an `ALTER`, and tightening
  either would foreclose a later free-grant path or break the exact mirror of 203 the
  vocabulary rests on. Migration 229's header carries the argument.
- `duration_cycles` is **nullable**: only a Periodic grant's quantity is a Duration (#1135),
  and a one-off Product has no billing cycles to express one in (#1118's `Q5`).
- FK to `promotions` is **RESTRICT** (a Promotion's own removal is a soft delete), to
  `member_products` **CASCADE** (a purchase and what it was priced under are one record).

**`receipt_sequences`** (migration 114) — `PRIMARY KEY (gym_id, year)`, `last_seq`. The
gapless per-gym, per-year counter behind a receipt number.

#### Receipts

A receipt ("factura simplificada") is issued for money **actually received**, and there is
exactly one implementation of that rule: `isReceiptableEvent()`
(`api/src/domain/billingEventStatus.ts`, #787). The event type must be one of
`payment_recorded | recurring_payment | failed_billing` **and**
`deriveBillingEventStatus()` must say `paid`. A `waived_billing`, an `adjustment`, and
anything failed, expired or pending are refused. There is no second eligibility check and
none on the `GET` routes — a `receipt_number` can only exist if the predicate already
allowed it.

The number comes from `issueReceiptNumber()` (`api/src/domain/receiptNumbers.ts`) and
nowhere else. It reads the event `FOR UPDATE` before spending anything, so one payment can
never burn two numbers; the format is `<year>-<4-digit seq>`, and the year is the one the
receipt is *issued* in. Two callers: `POST /payments/:id/receipt` (on demand) and the
nightly run (automatically, per settled charge).

### Assigned Plan status model

`STATUSES` and `ALLOWED_TRANSITIONS` in `api/src/api/user-memberships.ts`, and the
`user_memberships_status_check` CHECK (current definition: migration 234):

```
draft ──► pending_payment ──► active ◄──► paused
  └──────────┴─────────────────┴───────────┴──► cancelled
expired (assign-new-plan's own supersede on pre-#1108 rows)
```

An assignment is **`draft` from creation** (#1108 stage 1) — all three insert paths write
`ASSIGNMENT_CREATION_STATUS` — and `POST /user-memberships/:id/activate` is the one
transition that commits it (A2b). A Draft bills nothing, cannot be booked on, is not the
member's enrollment status and is excluded from the member's own reads; it *is* fully
editable and it *is* projected, so the Assigned Plan card's Billing Event Forecast answers
what committing it would bill (#1108 §5 / Q3).

`draft` is deliberately **outside** `LIVE_ASSIGNMENT_STATUSES` (#1108 Q2), so a member may
hold one Active plan and one Draft replacement at once — which is what makes a replacement
configurable before it is committed — and migration 213's UNIQUE index needs no change,
because `active_member_key` is `IF(status = 'active', member_id, NULL)`. The index still
backstops the commit, since the `draft → active` UPDATE populates that column.

Once active, the first payment is collected as A3–A6 describe. Nothing about it moves
`um.status`: the webhook's `completed` branch stamps `next_billing_date`, and the nightly run
skips the assignment until a card is on file.

#511 stage 1 (migration 148) had added two pre-activation statuses, `draft` and
`awaiting_payment`, with a **Submit** action (`POST /user-memberships/:id/submit`,
`draft → awaiting_payment`) — but no insert path produced them and no payment path moved a
row on to `active`, so they were unreachable, and an `awaiting_payment` row written by hand
would have been configurable and closeable but never activatable or payable. #786 retired
them: the route, the Submit menu item, the dates-and-discount Edit form that only those two
statuses could open, the `draft` Billing Events projection (its pure
`projectDraftBillingEvents()` / `computeMembershipFeePriceAt()` followed in #854), and every
status list that named them are gone, and migration 198 narrowed the CHECK back to four
values. That migration **refuses to run** while any row still holds a retired status, rather
than guess what the row should become.

**#1108 stage 1 brought `draft` back** — with the insert paths and the commit transition that
make it reachable, which is exactly what 198 said was missing — and left `awaiting_payment`
and `/submit` retired. Migration 227 is that widening; its `down` refuses to run while any
row holds a status the narrow CHECK would refuse, for 198's reason, so roll the application
half back first — every assignment path now writes a Draft, which makes that refusal the
ordinary outcome of rolling back out of order rather than a pathological one. #1108's second
pre-activation state is **Pending Payment**, and it is stage 2's: it arrives with the Save &
Pay transaction that produces it rather than as a value nothing can write for a second time.

> **Decisions (2026-09-27, #786)** — change them here if they turn out wrong:
> - Retired rather than wired: an assignment is `active` from creation and the first payment
>   is collected afterwards. Plan-gated booking (`activity-eligibility.ts`, `um.status =
>   'active'`) is therefore available before the first payment clears, as it always was.
> - No pre-activation step replaces **Submit**: there is no "prepare, then activate" flow.
> - Re-introducing a payment gate before activation later is a schema widening (the CHECK,
>   `STATUSES`, `ALLOWED_TRANSITIONS`) plus an activation write in the webhook and manual
>   payment paths — its own ticket, not a revert of this one. **That ticket is #1108**, whose
>   stage 1 did the widening (migration 227) and put the activation write in one explicit
>   route; the webhook and manual-payment half is its stage 2.

> **Decisions (2026-10-07, #1108 stage 2)** — change them here if they turn out wrong:
> - **Pending Payment is `pending_payment`** (migration 234), written only by
>   `POST /user-memberships/:id/save-and-pay`; `awaiting_payment` stays retired.
> - **The one-plan rule is asked at Save & Pay and performed at activation.** The 409 and
>   the `confirm` are Save & Pay's, so staff confirm the replacement before the member pays;
>   the supersede runs when the payment is confirmed, with that confirmation taken as given.
>   Nothing is cancelled while the payment is outstanding.
> - **A Draft that owes nothing activates immediately** from Save & Pay — there is no
>   payment to wait for, and a pending state nothing can confirm would strand it.
> - **The forecast is not pre-persisted as Billing Events.** The ticket's "consolidate the
>   simulation into real Billing Events" is read as the invariant it names — the real events
>   must match the simulation — which holds by construction because the Billing Event
>   Forecast is the same engine the nightly run prices from (#635 stage 12); writing two
>   cycles of future events into the ledger would be a second record of one fact for the run
>   to reconcile, and is not done. The ledger stays what was charged.
> - **A cash first payment stamps no `next_billing_date`** and stores no card: a cash
>   member has nothing for the nightly run to charge, exactly as a cash member had before.
> - **`POST /:id/activate` stays**, API-only (the card offers Save & Pay): a commit with no
>   payment around it, for a free plan or a staff shortcut, over the same `commitAssignment()`.

> **Decisions (2026-10-06, #1108 stage 1)** — change them here if they turn out wrong:
> - A Draft is **not** the member's Membership Plan: it is outside
>   `LIVE_ASSIGNMENT_STATUSES`, so one Active plan and one Draft replacement is a legal
>   state, and #956's check runs on the commit instead of on the four insert paths.
> - A Draft is **not bookable**: `activity-eligibility.ts`'s `um.status = 'active'` gate is
>   unchanged, which *is* a change in behaviour — an unpaid assignment was bookable from
>   creation under #786.
> - The Draft's projection is the Assigned Plan card's existing **Billing Event Forecast**;
>   no fourth section and no new name (#1108 Q3).
> - A Draft nobody commits does **not** expire (Q1a): staff discard it through
>   `POST /:id/close`, which is warning-free because a Draft has no ProductSet
>   and so no obligation.

`expired` is reached only by `assign-new-plan`'s supersede logic, never by request.

**Back to `active` (#790, retired by #1325 PR 3c).** `POST /user-memberships/:id/reactivate`
and a `status` flip through `PUT /user-memberships/:id` flip the status and nothing else:
there is no stored billing date to walk forward and no dunning pair to clear. **A pause is
still not a debt** — a ProductSet's obligations are its persisted scheduled events, and the
nightly run charges only the events of an `active` set that are due; what fell due while the
assignment was paused is not collected in a catch-up.

### Provider layer

`api/src/payments/`:

| File | What it is |
|---|---|
| `provider.ts` | the `PaymentProvider` interface: `createPaymentRequest`, `createCardVerificationRequest`, `parseWebhook`, `executeRecurring` |
| `types.ts` | the param/result shapes; both amount-carrying ones document minor units |
| `money.ts` | `toMinorUnits()` |
| `index.ts` | `getPaymentProvider()` (cached, env-driven), `SUPPORTED_PAYMENT_PROVIDER_KEYS`, `describePaymentDeployment()` |
| `providers/monei/` | `client.ts` (raw `Authorization` header, not Bearer; `MONEI-Account-ID` for Connect), `index.ts` (the adapter), `webhook.ts` (HMAC + status map), `types.ts` |

**Environment** (all config is env-only; no credential is ever stored in the database):

| Var | Used by |
|---|---|
| `PAYMENT_PROVIDER` (default `monei`) | `getPaymentProvider()` |
| `MONEI_API_KEY`, `MONEI_WEBHOOK_SECRET` | required — `getPaymentProvider()` throws without either |
| `MONEI_ACCOUNT_ID` | optional; needed because this is a MONEI Connect partner account |
| `PAYMENT_ENV` | informational, reported by `describePaymentDeployment()` |
| `PAYMENT_PAGE_URL` | builds the `checkoutUrl` (default `https://pay.vdicube.com`) |
| `PAYMENT_OK_URL`, `PAYMENT_KO_URL` | the hosted page's return URLs — **no locale segment** (`https://members…/payment/success`, not `/es/payment/success`), §A4 (#1081) |
| `PAYMENT_NOTIFICATION_URL` | the `callbackUrl` Monei posts the webhook to — the **payment app's** relay since #1083 (`https://pay.…/webhooks/payment`), not the API |
| `TRUST_PROXY_HOPS` | optional (default 1) — proxies in front of every route, `trustProxyHops()` |
| `PAYMENT_WEBHOOK_RELAY_HOPS` | optional (default 0) — the *further* hop `/webhooks/payment` sits behind once the payment app relays it; `paymentWebhookClientKey()`, §A5 (#1083) |
| `BILLING_INTERNAL_SECRET` | `/billing/run`, `/billing/cleanup`, `/billing/maintain-window` |
| `PAYMENT_REQUEST_ABANDONED_HOURS` | optional (default 24, floored at 1) — `abandonedRequestHours()`, §B8 |
| `RUN_FRESHNESS_THRESHOLD_HOURS` | optional (default 26, floored at 1) — `runFreshnessThresholdHours()`, `GET /health/runs` (#782) |
| `RECURRING_BOOKINGS_INTERNAL_SECRET` | `/recurring-bookings/run` |
| `INTERNAL_RUN_RATE_LIMIT_MAX`, `INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES` | optional (default 10 per 15 min, values below 1 ignored) — failed-secret budget per IP on the three internal run routes, §B1 (#783) |
| `INTERNAL_RUN_RELAY_HOPS` | optional (default 0) — the *further* hops the four internal run routes sit behind once the workflows post to the admin app's `/api/internal` relay; `internalRunClientKey()`, §B1 (#1086) |

The `payment_providers` catalogue (#636, `api/src/api/payment-providers.ts`) names **which**
adapter a gym uses (`gyms.payment_provider_id` → `provider_key`), never how to authenticate
as it. Every insert into `gyms` must set that column (NOT NULL since migration 175).

#### Card replacement is not a payment (#788)

`createCardVerificationRequest()` deliberately takes **no amount**; the Monei adapter sends
`amount: 0` + `transactionType: 'VERIF'` + `generatePaymentToken: true`. The
`payment_requests` row it writes exists only to carry the page token and the provider order:
`source = 'card_update'`, `amount = 0.00`, `charge_type_id` **NULL**. It is therefore not a
financial row, and every surface that reads `payment_requests` as money excludes it. The
pure rules live in `api/src/domain/storedCards.ts` (including `cardRemovalBlock()`: removal
is refused while any assignment is `active`/`paused` with a `next_billing_date`, because the
run skips a card-less assignment *silently*); the provider call, insert and reads live in
`api/src/api/card-updates.ts`.

**The payment's description is the purchase's name** (#3288). A checkout that charges a Purchase (a Product Set's Save & Pay, a standalone cart checkout, a direct one-time purchase, and any retry raised on such a checkout's Billing Event) sends the purchase's canonical name (`purchases.name`, e.g. `Gym Name - Compra - 23/11/2026 11:56`) as the provider's `description`, the very string its Billing Event carries (#3287). Where the purchase is created inside the checkout's transaction (a split-off cart, a direct purchase), the name is planned before the provider call (`planCheckoutPurchase()`) and the transaction refuses with `409 cart_changed` if the purchase it ends up charging is named otherwise. A payment no purchase owns keeps its generic description (`Membership fee`). The card-statement `descriptor` (25 characters at most, MONEI) is a different field and is not sent.

### Money rules

Stated in full in `CLAUDE.md`; linked here so one page can point at all of them.

- **Minor units at the provider boundary only** (#773, `docs/decisions.md` §17). Every
  caller of `createPaymentRequest()` and `executeRecurring()` converts through `toMinorUnits()`; everything on our side —
  `membership_fee_price`, `billing_events.amount`, `payment_requests.amount`, what
  `resolveMembershipFee()` returns — is a decimal number of euros. A test of a provider
  call asserts the `amount` the stub received (`api/src/test/payments-money.test.ts`).
- **One fee resolver.** `resolveMembershipFee()` and nothing else; the shared entry point is
  `api/src/api/membership-fee-pricing.ts` (`priceMembershipFeeOn`, `currentMembershipFee`,
  `FEE_ASSIGNMENT_COLUMNS`). No stored, promotion-discounted price column may be
  reintroduced.
- **Snapshot, not live catalogue.** Billing reads the Assigned Plan snapshot for an
  assignment that already exists; the cadence comes from `ASSIGNMENT_CADENCE` and therefore
  **LEFT** JOINs `billing_policies`.
- **Promotion snapshots.** A Promotion already applied to an assignment is priced from that
  application's own snapshot, never a live join.
- **Billing & Duration is the Plan's only billing section** since #635 stage 13
  (migration 189).
- **An initial charge's lines state their tax** (#2947). `initialCharge()` gives every line its rate
  and net (`domain/initialChargeTaxes.ts`): a Membership Fee its plan's effective rate, a Product its
  own, a cart purchase its frozen one, anything else the gym's system rate (the rate
  `invoiceLineTaxes()` falls back to). The net is split from the line's final, VAT-inclusive amount;
  the amount itself is the engine's and is never changed.

### Observability today

| What exists | Where |
|---|---|
| `billing/run: complete` with the counters, plus per-assignment `info`/`warn`/`error` lines | Pino → journald → Alloy → Grafana Cloud Loki (`infra/alloy/config-corback.alloy`) |
| A red workflow + GitHub notification on `failed > 0`, an unreadable body, or a non-2xx | `.github/workflows/billing-run.yml` (#778) |
| One row per run with counters and status | `billing_run_log` (#780) |
| Staff ledger with a `failed` filter, and per-event transactions | Payments → Billing Events |
| Monthly counters | `GET /payments/dashboard/summary` (#674) |
| Per-member badge | `GET /members` → `payment_status` |
| When each nightly run last **completed**, and whether that is overdue | `GET /health/runs` (#782) — unauthenticated, read by two Grafana Cloud alert rules (below, #872) |
| Users being answered **HTTP 429** by the API, and Clerk's Backend API rate-limiting the API | Two Grafana Cloud rules in folder **Gymdesk**, group `api-availability` (every 1 min, created 2026-10-11 by hand like the freshness ones): *users are getting 429 from the API* (`warning`, Loki `sum(count_over_time({service_name="fitness-api"} \|~ "statusCode\\\\?\":429" [5m])) or vector(0)` > 0) and *Clerk is rate-limiting the API* (`critical`, `\|= "ClerkAPIResponseError: Too Many Requests"` > 0). Both `No data → OK`, `keep_firing_for 10m`, routed to `gymdesk-dev`. |

**What does not exist:** an in-app staff alert for failed payments awaiting action (#779), any
reconciliation job against the provider, and any member notification of a failed internal
charge (decision 2026-09-26: internal only).

#### Run freshness — `GET /health/runs` (#782)

Every other signal above needs a run to have *happened*: a day on which GitHub never fired the
cron writes no log line, no run-log row and no red workflow. `GET /health/runs` turns that
absence into something an alert outside GitHub can see:

```json
{
  "billing":            { "last_completed_at": "2026-09-27T06:00:41.000Z", "age_hours": 3.2, "stale": false },
  "recurring_bookings": { "last_completed_at": "2026-09-27T06:10:05.000Z", "age_hours": 3.0, "stale": false }
}
```

- `last_completed_at` is the latest `finished_at` of a `status = 'completed'` row in
  `billing_run_log` / `recurring_booking_run_log` (`lastCompletedRun()`,
  `api/src/infra/run-log.ts`). A `failed` or `in_progress` row never counts, and the second
  daily attempt's `already_completed_today` answer writes no row — correctly, the earlier run
  is the one that completed.
- `stale` is `age_hours > RUN_FRESHNESS_THRESHOLD_HOURS` (default **26**, floored to whole
  hours, below 1 ignored — `runFreshnessThresholdHours()` / `evaluateRunFreshness()` in
  `api/src/domain/runFreshness.ts`, pure and unit-tested). A log that never completed a run
  answers `last_completed_at: null` and `stale: true`.
- **200 whenever the database answers**, stale or not — the alert rules read `stale`. **503**
  only when the run logs cannot be read.
- **Unauthenticated**, and it returns nothing else: no counters, no gym, no member.
- **Outside `/billing/`** on purpose: `/billing/` is the internal-run surface (shared secret plus its
  own rate limiter), which a Grafana Cloud alert must not share. The global API rate limiter
  (500 requests / 15 min per IP) applies; one request per rule every 5 minutes is far below it.
- **Read through the admin app** since #1166: `GET https://admin.vdicube.com/api/health/runs`
  relays to this route at `CORDEL_FITNESS_API_URL` (one path, no headers forwarded, the API's
  own status and body; 500/502/504 of its own when it cannot ask), so Grafana needs no public
  API once #1087 closes `api.vdicube.com`. Behind the relay the limiter keys on the admin app,
  the bucket `/api/proxy` already shares.

**Grafana Cloud setup (manual, not provisioned from the repo — configured 2026-10-06, #872):**

- Stack `maroonyogurt3482`, folder **Gymdesk** (uid `gymdesk`), rule group `run-freshness`,
  evaluated every **5 min**.
- Two Grafana-managed alert rules, one per run, each a single **Infinity** query
  (`grafanacloud-infinity`, backend parser) on `GET https://admin.vdicube.com/api/health/runs`
  (the admin relay, #1166 — repointed from `api.vdicube.com` on 2026-10-06) with
  root selector `billing` or `recurring_bookings`, the `stale` field as a boolean column and a
  computed column `stale ? 1 : 0`, followed by a threshold `> 0`:

  | Rule (uid) | Severity |
  |---|---|
  | *Gymdesk: nightly billing run is stale* (`gymdesk-billing-run-stale`) | `critical` |
  | *Gymdesk: recurring bookings run is stale* (`gymdesk-recurring-bookings-run-stale`) | `warning` |

- Pending period **10 min**; **No data → Alerting** and **Error → Alerting**, so a 503, a
  timeout or an unreachable host fires the same alert as a stale run — the summary says so.
- No `notification_settings` of their own: the default notification policy routes them to the
  `gymdesk-dev` contact point (email to Xavier and Oscar), group wait 30 s, repeat 4 h.
- Verify by copying a rule with the computed column inverted (`stale ? 0 : 1`), a 1-minute
  group and `notification_settings.receiver = empty`: it fires on the next evaluation and
  resolves once the column is put back (done 2026-10-06). Changing
  `RUN_FRESHNESS_THRESHOLD_HOURS` in the GitHub environment does nothing: `deploy.yml` does
  not forward it, so the API always runs on the 26 h default.
- A **Synthetic Monitoring** check, `gymdesk-run-freshness-dev` (HTTP, every 15 min, 2 probe
  locations, folder *Grafana Synthetic Monitoring*), also polls `/health/runs`: it feeds the
  stack's built-in *Failed Checks [30m]* rule and the check's uptime page. It was left on
  `https://api.vdicube.com/health/runs` when the Alerting rules were repointed, so it sat
  firing with 0% uptime once the API host stopped answering; repointed to
  `https://admin.vdicube.com/api/health/runs` on 2026-10-09 (#1166). Any new Grafana check
  against this endpoint uses the admin host, never `api.vdicube.com`.

> **Decisions (2026-09-27, #782)** — change them here if they turn out wrong:
> - Option (b): a DB-backed freshness endpoint read from Grafana Cloud — not a Loki query on the `billing/run: complete` log line and not a GitHub-scheduled
>   check, because a GitHub-hosted check shares GitHub's failure modes, which are exactly
>   what this alert exists to catch.
> - The endpoint is unauthenticated at `GET /health/runs`, outside `/billing/`, so the internal-run
>   secret and rate limiter never apply to the prober and no internal secret is handed to Grafana. It leaks one timestamp per internal job and nothing tenant-scoped.
> - One endpoint for both runs, default threshold 26 h (a daily run plus the 06:00/10:00
>   UTC spread), configurable through `RUN_FRESHNESS_THRESHOLD_HOURS`.
> - Grafana (alert rules, contact point) is configured by hand, not provisioned from the
>   repo — nothing in `infra/` provisions Grafana today (#872 Q1: UI).
> - (#872, 2026-10-06) The rules query the endpoint through the Infinity data source rather
>   than a Synthetic Monitoring check: one rule per run gives each its own severity, which a
>   single check asserting both flags cannot, and there is no probe to keep alive. It still
>   runs from Grafana Cloud, never from GitHub.

### Manual test runbook

Exercises A and B end to end against Monei **test** keys with throwaway data. This is the
script for the joint fake-user test. Read `⚠️` items before starting.

⚠️ Never run this against a database holding a real gym: step 8 writes
`user_memberships.next_billing_date` by hand, and step 9 charges **every** assignment the
run finds due, not only yours.

**0. Prepare**

```bash
npm run db:up && npm run db:migrate
cp api/.env.example api/.env     # then fill in the values below
```

In `api/.env`: `MONEI_API_KEY` and `MONEI_WEBHOOK_SECRET` from the Monei **test** account,
`MONEI_ACCOUNT_ID` if the key is a Connect partner key, and any
`BILLING_INTERNAL_SECRET` you like. `PAYMENT_NOTIFICATION_URL` must be a URL Monei can
reach — use a tunnel (`cloudflared tunnel --url http://localhost:3000`) and point it at
`/webhooks/payment`, or skip the hosted page entirely and drive the webhook by hand
(step 7b). Nothing relays locally: #1083's relay is a block of the payment *container's*
nginx config, and local development runs no such container, so the tunnel still points at
the API's own route and `PAYMENT_WEBHOOK_RELAY_HOPS` stays unset.

```bash
npm run dev:api      # :3000
npm run dev:admin    # :8081
npm run dev:member   # :8082
```

Register the tunnel URL as the webhook endpoint in the Monei test dashboard, subscribing to
**charge** events.

**1. A gym, a member, a Plan.** In the admin app: create the gym (or use the seed), then
Members → New, then Financials → Plans → New with a price and a Billing & Duration
frequency (e.g. `1 month`). Leave Free/Pre-paid/Bonus at 0 for the happy path.

**2. Assign the Plan.** Members → the member → Membership Plans → Assign. Verify:

```sql
SELECT id, status, starts_at, next_billing_date, membership_fee_price
FROM user_memberships WHERE member_id = <id>;
```

Expect `status = 'active'`, `next_billing_date` **NULL**, and a frozen
`membership_fee_price`. Also expect one `status_change` row in `audit_logs` for the assignment.

**3. Raise the payment request.** Either the staff route (Payments → the member → request a
payment) or, signed in as the member on :8082, the member's own **Start payment**. Verify a
`pending` `payment_requests` row with the right `source`, a `page_token`, and — for the
member route — a non-NULL `consent_given_at`. `checkoutUrl` is in the response.

**4. Pay.** Open `checkoutUrl`. Tick consent, enter a Monei **test card** that succeeds, and
complete 3DS.

**5. Assert the completed path.**

```sql
SELECT status, completed_at, billing_event_id FROM payment_requests WHERE id = <pr>;
SELECT event_type, amount, source FROM billing_events WHERE id = <billing_event_id>;
SELECT card_brand, card_last4, updated_at FROM payment_methods WHERE member_id = <id>;
SELECT next_billing_date FROM user_memberships WHERE id = <um>;
```

Expect `completed`; a `payment_recorded` event with `source = 'provider'` carrying the same
amount, back-linked both ways; a `payment_methods` row; and `next_billing_date` =
`starts_at + cadence` for a `starts_at` of today or later.

With a back-dated `starts_at`, expect instead the first `starts_at + n·cadence` **after**
today (#790) — never a date in the past — and the next run to charge nothing for it.

**5b. Settled without the webhook (#2087).** Repeat 3–4 with `PAYMENT_NOTIFICATION_URL`
pointing at a URL that does not answer (or the tunnel stopped). Expect the request to be
`completed` and the plan active the moment the page redirects, and the API log to carry
`Payment settlement: completed` with `via: "confirm"`. With a 3DS card, expect the same line
when the Members App's success page loads, and check that MONEI's `completeUrl` redirect
carries the payment `id` in its query — the return page confirms with it. Restore the
notification URL and let MONEI retry: the webhook logs `already processed, skipping`.

**6. Declined first payment.** Repeat 3–4 with a Monei test card that **declines**. Expect
the request to end `failed` and — correctly — **no** `billing_events` row at all, which is
why a failed first payment is invisible to the staff ledger (#779 Q2).

**7b. Driving the webhook by hand** (no tunnel). Sign the body yourself:

```bash
BODY='{"id":"evt_1","type":"charge.succeeded","objectType":"charge","objectId":"ch_1","accountId":"acc_1","livemode":false,"createdAt":0,"object":{"id":"ch_1","orderId":"<provider_order>","status":"SUCCEEDED","paymentToken":"tok_test","sequenceId":"seq_test","paymentMethod":{"card":{"last4":"4242","brand":"visa"}}}}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$MONEI_WEBHOOK_SECRET" -hex | sed 's/.*= //')
curl -sS -X POST http://localhost:3000/webhooks/payment \
  -H "MONEI-Signature: t=$T,v1=$SIG" -H 'Content-Type: application/json' -d "$BODY"
```

Take `<provider_order>` from the `payment_requests` row. A bad signature must answer `400`
with nothing written.

**8. Make the cycle due.**

```sql
UPDATE user_memberships SET next_billing_date = UTC_DATE() WHERE id = <um>;
```

**9. Run the nightly charge.**

```bash
curl -sS -X POST http://localhost:3000/billing/run \
  -H "X-Internal-Secret: $BILLING_INTERNAL_SECRET"
```

Expect `{ processed: 1, succeeded: 1, failed: 0, waived: 0, paused: 0, receipts_issued: 1 }`,
then:

```sql
SELECT be.event_type, be.amount, be.receipt_number FROM billing_events be
  JOIN product_sets ps ON ps.id = be.product_set_id
 WHERE ps.owner_member_id = (SELECT owner_member_id FROM product_sets WHERE user_membership_id = <um> LIMIT 1)
 ORDER BY be.id DESC LIMIT 3;
SELECT status, source, amount FROM payment_requests WHERE user_membership_id = <um> ORDER BY id DESC LIMIT 3;
```

Expect a `recurring_payment` event **with a receipt number**, a `completed`
`source = 'billing_run'` transaction, `last_billed_at` stamped, `next_billing_date` advanced
one interval, and `failed_attempts = 0`.

**10. Assert the run guard.** Immediately re-run step 9. Expect
`200 { skipped_reason: 'already_completed_today', run_date, … }` with every counter zero —
**not** a 429, and not a second charge.

**11. A rejected recurring charge, and the pause.** Replace the stored token with one the
test account declines (or swap the card via the member's **Replace card** flow using a
declining test card), make the cycle due again, and run step 9 on **two different UTC
dates** (the day gate is `DATE(last_failed_at) = UTC_DATE()`; to simulate, set
`last_failed_at` back a day rather than waiting):

- run 1 → `failed: 1`, `paused: 0`, the event is `failed_billing` with one `failed` attempt
  carrying the provider's code, and `GET /user-memberships/:id` reports a derived
  `failed_attempts = 1`;
- run 2 (next UTC day) → `failed: 1`, `paused: 1`, `status = 'paused'`, plus a
  `status_change` audit row with `source = 'system'`;
- run 3 → the assignment is no longer selected at all.

**12. Settle it by hand.** On the failed event, Payments → Billing Events → **Retry Payment**
(after restoring a good token) or **Manual payment**. Expect a new `payment_requests` row on
the **same** `billing_event_id` with an incremented `attempt`, **no** new Billing Event, the
event's derived status flipping to `paid`, `failed_attempts` back to 0, and
`next_billing_date` advanced. The assignment stays `paused` — reactivate it explicitly via
its Assigned Plan.

**12a. The Billing Event actions (#1459).** The row's `⋮` offers, only where the API's flags
say so: **Pay Cash**, **Pay Card (external terminal)**, **Retry Payment** and **Waive**; there is
no Cancel. Pay Cash / Pay Card open a modal with the member, the full amount and the method —
closing it records nothing. **Accept** adds one completed attempt with `method` `cash` or
`card_terminal` (no provider call; Gymdesk cannot verify the terminal, staff do) on the same
event. A membership's *first* payment (Pending Payment) settles through
`POST /user-memberships/:id/record-payment` with the same `method`, which also activates it.
**Waive** needs a reason and writes a `waive` attempt of 0.00 on the same event, which becomes
`waived_billing`: no receipt, no money received, and it can no longer be paid or retried (409).
Submitting a settlement twice (or concurrently) leaves exactly one completed attempt.

**12b. Pay now (#3442).** The `⋮` of a **Failed**, **Pending payment** or **Scheduled** event that
nothing has paid offers **Pay now** (`can_pay_now`). Its modal reads `GET
/payments/billing-events/:id/pay-now` (the active catalogue methods; Members App, Cash and Card
usable, the stored-card Monei charge stays **Retry Payment**) and writes nothing until **Pay**
sends `POST …/pay-now` `{ method }`. *Members App* raises a hosted checkout as an attempt on the
**same** event — a still-valid link nobody opened is reused, a lapsed unopened one is expired —
and the webhook settles it; a scheduled obligation or failed charge paid this way leaves the
schedule (`is_scheduled = 0`, `recurring_payment`). *Cash* / *Card* record a completed
`cash` / `card_terminal` attempt with no provider call: an unopened link is expired first, a
scheduled obligation leaves the schedule (the nightly run finds nothing to collect on its date),
and the initial event of a Pending Payment Product Set activates it in the same transaction, as
the webhook does. Refused under the event's row lock, with `chargeGuard()`, for a paid event
(`409 already_paid`), one whose provider charge is unresolved (`409 payment_unresolved`) and a
Pending payment event whose cart was cancelled or expired (`409 cart_cancelled` / `cart_expired`,
shown in the modal before any method). Never a new Billing Event.

**13. Receipts.** `POST /payments/:id/receipt` on the settled event issues a number if the
run did not; calling it twice must return the **same** number. `GET /me/receipts/:id` serves
it to the member. A `waived_billing` event must be refused with a reason.

**14a. A pre-paid cycle (#946).** Give the Plan a Pre-paid Duration of 2 and a Paid Duration
of 3, assign it and pay the first request: it asks for twice the fee. Run the billing run on
the next cycle — it is one of the periods that charge paid for, so expect `waived: 1` and a
`waived_billing` event with `notes 'prepaid_plan'`.

**14. A waived cycle.** Give the Plan a Free Period (or a Promotion whose Membership Fee
Benefit covers the date), assign it, make the cycle due, and run step 9. Expect
`waived: 1`, a `waived_billing` event with `amount 0` and the period status in `notes`,
**no** `payment_requests` row, `next_billing_date` advanced, and `last_billed_at`
**untouched**.

**15. Cleanup, both deadlines (#789).** Raise **two** requests. Open the checkout page of
the second one only (`GET /payment-page/token/:token`, which clears its `page_token`), do not
pay either, back-date both past the ten-minute TTL, then:

```bash
curl -sS -X POST http://localhost:3000/billing/cleanup -H "X-Internal-Secret: $BILLING_INTERNAL_SECRET"
```

Expect `{ expired: 1, expired_unopened: 1, expired_abandoned: 0 }`: the untouched request is
`expired` with `page_token = NULL`, and the **opened** one is still `pending` — that is the
whole point, because a completed webhook must still be able to land on it. To see the second
deadline, back-date the opened row's `page_token_expires` by more than
`PAYMENT_REQUEST_ABANDONED_HOURS` (default 24) and run cleanup again:

```sql
UPDATE payment_requests SET page_token_expires = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR)
WHERE id = <the opened request>;
```

Expect `{ expired: 1, expired_unopened: 0, expired_abandoned: 1 }`.

**16. Tear down.** Drop the throwaway gym, or `npm run db:down` and start clean.

### Open gaps

The #778–#790 hardening range in full, so this page says what is **not** built rather than
implying it is. Nothing above describes an open row as working; the ✅ rows are here because
the range was asked for and because each one changed behaviour a reader may remember
differently.

| # | Gap |
|---|---|
| [#778](https://github.com/cordel-app/gymdesk/issues/778) | ✅ done — the workflow reports the run's outcome |
| [#779](https://github.com/cordel-app/gymdesk/issues/779) | ✅ done — sidebar badge + dashboard card for failed payments awaiting action (B7) |
| [#780](https://github.com/cordel-app/gymdesk/issues/780) | ✅ done — one completed run per UTC date |
| [#781](https://github.com/cordel-app/gymdesk/issues/781) | ✅ done — a second daily attempt |
| [#782](https://github.com/cordel-app/gymdesk/issues/782) | partly done — endpoint shipped; Grafana check/alert pending (go-to-production) |
| [#783](https://github.com/cordel-app/gymdesk/issues/783) | ✅ done — allowlist removed; per-route limiter; secret rotation pending (go-to-production) |
| [#784](https://github.com/cordel-app/gymdesk/issues/784) | partly done — workflows parametrised; production environment pending (go-to-production) |
| [#785](https://github.com/cordel-app/gymdesk/issues/785) | ✅ done — a rejection escalates to a pause |
| [#786](https://github.com/cordel-app/gymdesk/issues/786) | ✅ done — `draft`/`awaiting_payment` and `POST /:id/submit` retired; an assignment is `active` from creation |
| [#787](https://github.com/cordel-app/gymdesk/issues/787) | ✅ done — the run allocates receipt numbers |
| [#788](https://github.com/cordel-app/gymdesk/issues/788) | ✅ done — replacing a card charges nothing |
| [#789](https://github.com/cordel-app/gymdesk/issues/789) | ✅ done — cleanup keeps an opened request `pending`, so a member's payment is not lost |
| [#790](https://github.com/cordel-app/gymdesk/issues/790) | ✅ done — the first `next_billing_date` (and a reactivated one) is the first boundary after today; elapsed and paused cycles are written off |
| — | Partly closed by [#2087](https://github.com/cordel-app/gymdesk/issues/2087): a first payment is read back from the provider when the hosted page finishes and before cleanup writes an opened request off (§A4, §B8). There is still no job that compares settled rows, recurring (MIT) charges or refunds against the provider. |

Production-readiness items (live credentials, Monei AoC, SRI for `monei.js`, the dedicated
`fitness-pay` VPS) are tracked in `docs/go-to-production.md` §5, not here.

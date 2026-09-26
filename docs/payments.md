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

Three routes insert a `user_memberships` row, and all three hardcode `status = 'active'`:

| Route | File |
|---|---|
| `POST /user-memberships` | `api/src/api/user-memberships.ts:636` |
| `POST /user-memberships/:id/assign-new-plan` | `api/src/api/user-memberships.ts:865` |
| `POST /membership-plans/:id/assign` | `api/src/api/membership-plans.ts:553` |

Each one, in the same transaction:

- writes a `status_changed` Billing Event through `recordStatusChange()`
  (`api/src/api/billing-events.ts`), `previousStatus: null → 'active'`;
- calls `snapshotAssignedPlan()` (`api/src/api/assigned-plan-snapshot.ts`) — the Assigned
  Plan owns the commercial configuration it was assigned with (#635 §11–§17).

What it does **not** write: `next_billing_date` (still NULL), a `payment_requests` row, or
a `payment_methods` row. So an assignment is `active` — bookable, per
`api/src/api/activity-eligibility.ts`'s `um.status = 'active'` gate — from the moment it is
created, and the nightly run skips it silently until a card is on file.

`draft` and `awaiting_payment` exist in the status vocabulary and **no code path creates
them** — see [Assigned Plan status model](#assigned-plan-status-model) and #786.

### A3. A payment request is raised

Two routes, same shape:

| | Staff | Member |
|---|---|---|
| Route | `POST /payment-requests` (`api/src/api/payment-requests.ts`) | `POST /me/payment-requests` (`api/src/api/me.ts:1599`) |
| Gate | `requireModuleWrite('PAYMENTS')` | `requireRole('member')`, **3/hour** per Clerk user id |
| `source` | `admin` | `customer` |
| Records who | `initiated_by` = the staff Clerk user id | `consent_given_at = UTC_TIMESTAMP()` |

Both then do exactly the same thing:

1. **Price the cycle.** `currentMembershipFee(gymId, umId)`
   (`api/src/api/membership-fee-pricing.ts`) → `priceMembershipFeeOn(row, currentCycleDate(row))`.
   A fee of `0` is refused with `400 This membership owes nothing for its current billing
   cycle` — the provider is never called and no row is written.
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
   `${PAYMENT_PAGE_URL}/checkout?token=<page_token>`.

The member route has one extra rule from #634 (a member may hold several active Plans):
`user_membership_id` says which assignment is being paid for; without it the request is
accepted only while exactly one candidate is `active`, otherwise
`409 { error: 'multiple_active_memberships', user_membership_ids }`.

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

### A5. The webhook settles it

`POST /webhooks/payment` (`api/src/api/webhooks.ts`), mounted in `app.ts:124` **before**
`express.json()` with `express.raw({ type: '*/*' })` so the HMAC can be verified against the
exact bytes Monei signed. 60 req/min per IP.

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

The `completed` transaction (`webhooks.ts:235-319`):

1. `payment_requests` → `status = 'completed'`, `provider_ref`, `completed_at`;
2. a `payment_recorded` Billing Event (`source = 'provider'`, `actor_user_id` NULL) carrying
   the request's own `amount` and `charge_type_id`;
3. `payment_requests.billing_event_id` ← that insert's `insertId`
   (read off the query result, *not* off `rows` — the defect #635 stage 3 fixed, which
   rolled back every real completion);
4. `user_memberships.failed_attempts = 0, last_failed_at = NULL` — #785's dunning state is
   spent, unconditionally, because the cycle is settled whether or not a token came back;
5. **only when `paymentToken` *and* `sequenceId` are present**: the `payment_methods`
   upsert (`ON DUPLICATE KEY UPDATE` on `(gym_id, member_id, provider)`, stamping
   `updated_at`), and the **first `next_billing_date`**:

```sql
SET um.next_billing_date = DATE_ADD(um.starts_at, INTERVAL <cadence>)
WHERE um.id = ? AND um.next_billing_date IS NULL
```

The cadence is `ASSIGNMENT_CADENCE` (`api/src/api/assigned-plan-snapshot.ts`) — the
assignment's frozen pair, its Plan's live `billing_policies` row only as a fallback, hence
the **LEFT** JOIN. `WHERE next_billing_date IS NULL` means only the *first* payment stamps
it.

> ⚠️ A known defect lives in this step. **#790**: `starts_at` is whatever the staff
> typed, so a back-dated assignment gets a `next_billing_date` in the past and is charged
> one catch-up cycle per night.
>
> The other one that lived here is closed. **#789**: `POST /billing/cleanup` used to expire
> a request the member was still paying through, after which the guard above skipped the
> completed webhook as "already processed" and the charge was lost. Cleanup now keeps an
> opened request `pending` for hours — §B8.

### A6. What is visible afterwards

| Surface | Route |
|---|---|
| Member's payment history | `GET /me/payment-requests` — excludes `source = 'card_update'` |
| Member's ledger and receipts | `GET /me/billing-events`, `GET /me/receipts/:billingEventId` |
| Member's plan, fee and upcoming charges | `GET /me/membership` (`me.ts:1384`) — `membership_fee` and `upcoming_payments` are both computed through `resolveMembershipFee()`, never read from a column |
| Staff transaction list / detail | `GET /payment-requests`, `GET /payment-requests/:id` — both exclude `card_update` |
| Staff ledger | `GET /payments/billing-events` |
| Members list badge | `GET /members` → `payment_status`, the status of the member's latest non-`card_update` transaction, following `user_membership_members` so a family plan's covered members inherit the owner's (`api/src/api/members.ts:112-120`) |

---

## B. Recurring charge (MIT)

### B1. Trigger

`.github/workflows/billing-run.yml` fires `POST /billing/run` twice a day — `0 6 * * *` and
`0 10 * * *` UTC, the second being #781's safety net for a schedule GitHub dropped — then
`POST /billing/cleanup` (with `if: ${{ !cancelled() }}`, so cleanup runs even when the
charge step went red).

- Auth is `checkInternalSecret()`: the `X-Internal-Secret` header against
  `BILLING_INTERNAL_SECRET`.
- `infra/nginx/corback.conf:22` additionally restricts `location /billing/` to GitHub
  Actions IPs, from a file refreshed by hand
  (`infra/nginx/update-github-actions-allowlist.sh`). `/recurring-bookings/` has **no**
  `location` block at all and is therefore not restricted. #783 decides whether to automate
  the refresh or drop the allowlist.
- `environment: dev` — there is no `production` GitHub environment yet (#784).

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

### B3. Selection

```sql
WHERE um.status = 'active'
  AND um.next_billing_date IS NOT NULL
  AND um.next_billing_date <= UTC_DATE()
  AND <cadence interval> IS NOT NULL AND <cadence unit> IS NOT NULL
```

plus `JOIN payment_methods pm ON pm.member_id = um.member_id AND pm.gym_id = um.gym_id`
(INNER — no card, no selection), and LEFT JOINs to `membership_plans` and
`billing_policies` because the cadence is `ASSIGNMENT_CADENCE`
(`COALESCE(um.recurring_billing_*, bp.recurring_billing_*)`).

What is **not** checked: `ends_at` and `auto_renew`. An assignment past its end date is
still charged while its status is `active` and its `next_billing_date` is due.

Before the loop the run resolves `charge_types.code = 'membership_fee'` and **fails the
whole run** (`500`, log row closed as `failed`) if it is missing — since migration 195 made
`payment_requests.charge_type_id` nullable, that lookup is the only thing left standing
between a broken install and charges recorded with no charge type.

### B4. Pricing

The cycle billed is the one `next_billing_date` **names**, never "today":

```ts
const billingDate = toDateOnly(row.next_billing_date);
const priced      = await priceMembershipFeeOn(row, billingDate);
const nextBillingDate = advanceBillingDate(row.next_billing_date, interval, unit);
```

`priceMembershipFeeOn()` (`api/src/api/membership-fee-pricing.ts`) delegates to
`resolveMembershipFee()` (`api/src/domain/billingSimulation.ts`) — the **one**
implementation of "what does the Membership Fee cost on this date", shared with the Billing
Simulation, the Billing Events projection, `GET /me/membership` and every staff screen. So
what the run charges cannot drift from what the member was shown.

Since #635 stage 15 (migration 191) this is unconditional: there is no
`billing.date_aware_membership_fee` flag, no stored `user_memberships.final_price`, and no
Membership Fee Drift report. `advanceBillingDate()` (`api/src/domain/billingDate.ts`)
advances the date exactly **one** interval per run. It does the arithmetic in **JS**, not in
SQL, because MySQL will not take an `INTERVAL` unit as a bind parameter; month and year steps
therefore clamp the way `Date.setUTCMonth` does (31 Jan + 1 month = 3 Mar), and every
projection in the codebase inherits that by going through this one function.

### B5. Outcomes

Per due assignment, exactly one of these:

| Outcome | Provider called | `billing_events` | `payment_requests` | `user_memberships` |
|---|---|---|---|---|
| **Waived** (`priced.waived`) | no | `waived_billing`, `amount 0`, `notes = periodStatus` | — | `next_billing_date` advanced, `failed_attempts = 0`, `last_failed_at = NULL`. **`last_billed_at` untouched** |
| **No stored token** | no | `failed_billing`, `notes 'no_payment_method'` | — | nothing |
| **Success** | yes | `recurring_payment` | one `completed` row, `source 'billing_run'`, back-linked | `last_billed_at = now`, `next_billing_date` advanced, dunning cleared |
| **Rejected** | yes, declined | `failed_billing`, `notes = "<code>: <message>"` | one `failed` row, `source 'billing_run'`, with `failure_code`/`failure_message` | `failed_attempts`, `last_failed_at`; possibly `status = 'paused'` |
| **Provider error** (threw / never answered) | attempted | `failed_billing`, `notes 'provider_error'` | — | **nothing at all** |

Counters returned: `{ processed, succeeded, failed, waived, paused, receipts_issued }`.
The first four are also written to `billing_run_log`; `paused` and `receipts_issued` are
reported only — a pause is already explicable from its `status_changed` ledger row, and a
receipt that failed to auto-issue is not a failed run.

A settled charge also allocates a receipt number, **after** the charge transaction has
committed and in one of its own, with any failure logged and swallowed
(`api/src/api/billing.ts`; see [Receipts](#receipts)).

### B6. Dunning — a rejection escalates, it does not repeat (#785)

The rule is pure and unit-tested in `api/src/domain/billingDunning.ts`
(`countsTowardPause`, `registerRejection`), and migration 194 adds
`user_memberships.failed_attempts` + `last_failed_at`.

- Only a **provider rejection** counts. `provider_error` (outcome unknown — a night the
  provider is unreachable would otherwise pause a gym's whole book) and
  `no_payment_method` (nothing was attempted) leave the counter exactly as it was, in both
  directions.
- The count advances per run **day**: `DATE(last_failed_at) = UTC_DATE()`, compared in SQL.
  A rejection on a date the assignment was already rejected on is recorded but does **not**
  escalate, because #781's 10:00 attempt becomes the day's real run whenever the 06:00 one
  crashed.
- The **second** consecutive rejection of the cycle `next_billing_date` names sets
  `status = 'paused'` through `recordStatusChange(… 'active' → 'paused', source 'system')`.
  That *is* the whole mechanism: a `paused` row is outside the run's
  `WHERE status = 'active'`.
- The retry is therefore the **next run day** — `next_billing_date` not moving is what
  schedules it.
- The decision is taken from the row **under the run's `FOR UPDATE` lock**, never from the
  row the due query read before the provider round trip: a staff payment landing in that
  window clears the pair, and deciding from the stale count would pause a member who has
  just paid.
- Everything that settles or skips the cycle clears the pair: the run's success and waived
  branches, the webhook's `completed` branch, both staff actions via `clearDunningState()`
  (`api/src/domain/billingEventPayments.ts`), and any transition back to `active`.
- Reactivation stays **explicit**. Clearing the count never flips `paused → active`; staff
  use `POST /user-memberships/:id/reactivate`.

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

Nothing notifies the member of a failed internal charge, and nothing notifies the staff
in-app either — #779 is the staff alert, and `failed_last_month` on the Payments dashboard
is a monthly statistic, not a to-do.

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

Answers `{ expired, expired_unopened, expired_abandoned }`. **`expired` stays the total**,
because `.github/workflows/billing-run.yml` parses that field by name (#778); the two
components are reported beside it, not instead of it. It runs twice a day because the
workflow does (#781), which is harmless: expiring stale pending requests is idempotent.

> Until #789 this was one statement on the ten-minute deadline, which expired requests
> members were part-way through paying — and §A5's `pr.status !== 'pending'` guard then
> skipped the completed webhook, so the money moved and Gymdesk kept no record of it: no
> `payment_methods` row, no `next_billing_date`, and the member app still offering to pay.
> Do not collapse the two deadlines back into one, and do not add a shorter window that
> expires an opened request.

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
- `source` ∈ `admin | customer | billing_run | retry | manual | card_update`
  (`chk_payment_requests_source`, widened by 111, 165 and **195**).
- `attempt` (default 1), `failure_code`, `failure_message`, `notes` — #640.
- `consent_given_at` (member's MIT consent), `initiated_by` (staff Clerk user id).

**`payment_methods`** (migration 103) — the stored card, `UNIQUE (gym_id, member_id,
provider)`. `payment_token` + `sequence_id` are the credentials that charge the member and
**never leave the API** (`describeStoredCard()`, `api/src/domain/storedCards.ts`).
`updated_at` (migration 195) is when the card *on file now* was stored; `created_at`'s
default was normalised to `UTC_TIMESTAMP()` in the same migration so the pair share one
clock.

**`billing_events`** (migration 008) — the append-only ledger **of the past only**. It has
no status column: an event's status is its latest linked transaction's, falling back to the
event type (`deriveBillingEventStatus()`, `api/src/domain/billingEventStatus.ts`).

- `event_type` ∈ `charge_created | payment_recorded | status_changed | adjustment |
  recurring_payment | failed_billing | waived_billing` — `billing_events_event_type_check`,
  current definition in **migration 185**. A new type goes in **two** places: the writer
  *and* that CHECK, or the INSERT fails and takes the run's transaction with it.
- `source` ∈ `admin | system | employee | customer | provider`.
- `receipt_number` + `receipt_issued_at` — see [Receipts](#receipts).
- `previous_status`/`new_status` carry a `status_changed` row's transition.

**Future rows are never persisted.** Three surfaces project the gym-wide future on read,
each pricing every projected date through the same resolver the run uses:

| Surface | File |
|---|---|
| `GET /payments/billing-events` — a rolling 5-date window per active assignment, `type: 'virtual'`, `status: 'scheduled'`, each amount priced for its own date | `api/src/api/payments.ts:310-395` |
| `GET /payments/dashboard/summary` — `scheduled_this_month` | `api/src/api/payments-dashboard.ts` |
| `GET /me/membership` — `upcoming_payments` | `api/src/api/me.ts:1453` |

Two further projections are scoped to one record rather than the gym:
`api/src/domain/assignedPlanBillingEvents.ts` serves an Assigned Plan's own Billing Events
view (#511 stage 3), and `api/src/domain/billingForecast.ts` projects a *Membership Plan's*
events (#485, deliberately promotion-free). Both are pure and unit-tested.

**`billing_run_log`** / **`recurring_booking_run_log`** (migration 193) — **histories**,
one row per run: `run_date DATE`, `status`, `started_at`, `finished_at`, and each job's own
counters (`processed, succeeded, failed, waived` / `processed, created, skipped, failed,
notified`). Both deliberately have **no `gym_id`** (migration 111's exception): a nightly
run is a system-wide job, not tenant data. `status` ∈ `in_progress | completed | failed`
(`chk_<table>_status`).

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

`STATUSES` and `ALLOWED_TRANSITIONS` in `api/src/api/user-memberships.ts:49-63`:

```
draft ──► awaiting_payment ──► active ◄──► paused
  └──────────┴──────────────────┴──────────┴──► cancelled
                                          expired (assign-new-plan only)
```

**Which are live today:** `active`, `paused`, `cancelled`, `expired`. `draft` and
`awaiting_payment` are **unreachable** — all three insert paths hardcode `'active'`, and no
path moves `awaiting_payment → active` (the webhook writes `next_billing_date`, never
`um.status`). `POST /user-memberships/:id/submit` and the **Submit** action it backs
(`apps/admin/src/app/[locale]/financials/assigned-plans/AssignedPlanExpandedRow.tsx:191`,
gated on `detail.status === 'draft'`) are therefore unreachable.
#786 decides whether to wire the pre-activation states to the first payment or retire them.

`expired` is reached only by `assign-new-plan`'s supersede logic, never by request.

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
| `PAYMENT_OK_URL`, `PAYMENT_KO_URL` | the hosted page's return URLs |
| `PAYMENT_NOTIFICATION_URL` | the `callbackUrl` Monei posts the webhook to |
| `BILLING_INTERNAL_SECRET` | `/billing/run`, `/billing/cleanup` |
| `PAYMENT_REQUEST_ABANDONED_HOURS` | optional (default 24, floored at 1) — `abandonedRequestHours()`, §B8 |
| `RECURRING_BOOKINGS_INTERNAL_SECRET` | `/recurring-bookings/run` |

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

### Observability today

| What exists | Where |
|---|---|
| `billing/run: complete` with the counters, plus per-assignment `info`/`warn`/`error` lines | Pino → journald → Alloy → Grafana Cloud Loki (`infra/alloy/config-corback.alloy`) |
| A red workflow + GitHub notification on `failed > 0`, an unreadable body, or a non-2xx | `.github/workflows/billing-run.yml` (#778) |
| One row per run with counters and status | `billing_run_log` (#780) |
| Staff ledger with a `failed` filter, and per-event transactions | Payments → Billing Events |
| Monthly counters | `GET /payments/dashboard/summary` (#674) |
| Per-member badge | `GET /members` → `payment_status` |

**What does not exist:** an in-app staff alert for failed payments awaiting action (#779), a
freshness/dead-man's-switch alert for a run that never happened (#782), any reconciliation
job against the provider, and any member notification of a failed internal charge
(decision 2026-09-26: internal only).

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
(step 7b).

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
`membership_fee_price`. Also expect one `status_changed` row in `billing_events`.

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
`starts_at + cadence`.

⚠️ If `starts_at` is in the past, `next_billing_date` will be too — that is **#790**, not a
setup mistake. Use a `starts_at` of today for a clean run.

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
SELECT event_type, amount, receipt_number FROM billing_events WHERE user_membership_id = <um> ORDER BY id DESC LIMIT 3;
SELECT status, source, amount FROM payment_requests WHERE user_membership_id = <um> ORDER BY id DESC LIMIT 3;
SELECT last_billed_at, next_billing_date, failed_attempts FROM user_memberships WHERE id = <um>;
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

- run 1 → `failed: 1`, `paused: 0`, `failed_attempts = 1`, a `failed_billing` event with the
  provider's code in `notes`, and `next_billing_date` **unchanged**;
- run 2 → `failed: 1`, `paused: 1`, `status = 'paused'`, plus a `status_changed` row with
  `source = 'system'`;
- run 3 → the assignment is no longer selected at all.

**12. Settle it by hand.** On the failed event, Payments → Billing Events → **Retry Payment**
(after restoring a good token) or **Manual payment**. Expect a new `payment_requests` row on
the **same** `billing_event_id` with an incremented `attempt`, **no** new Billing Event, the
event's derived status flipping to `paid`, `failed_attempts` back to 0, and
`next_billing_date` advanced. The assignment stays `paused` — reactivate it explicitly via
its Assigned Plan.

**13. Receipts.** `POST /payments/:id/receipt` on the settled event issues a number if the
run did not; calling it twice must return the **same** number. `GET /me/receipts/:id` serves
it to the member. A `waived_billing` event must be refused with a reason.

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
| [#779](https://github.com/cordel-app/gymdesk/issues/779) | No in-app staff indicator of failed payments awaiting action |
| [#780](https://github.com/cordel-app/gymdesk/issues/780) | ✅ done — one completed run per UTC date |
| [#781](https://github.com/cordel-app/gymdesk/issues/781) | ✅ done — a second daily attempt |
| [#782](https://github.com/cordel-app/gymdesk/issues/782) | No freshness alert: a day on which *nothing* reached the API is invisible |
| [#783](https://github.com/cordel-app/gymdesk/issues/783) | The `/billing/` GitHub Actions IP allowlist decays by hand; `/recurring-bookings/` has none |
| [#784](https://github.com/cordel-app/gymdesk/issues/784) | No `production` GitHub environment; `API_BASE_URL` is a literal in the workflow |
| [#785](https://github.com/cordel-app/gymdesk/issues/785) | ✅ done — a rejection escalates to a pause |
| [#786](https://github.com/cordel-app/gymdesk/issues/786) | `draft`/`awaiting_payment` are unreachable statuses, and `POST /:id/submit` is dead code |
| [#787](https://github.com/cordel-app/gymdesk/issues/787) | ✅ done — the run allocates receipt numbers |
| [#788](https://github.com/cordel-app/gymdesk/issues/788) | ✅ done — replacing a card charges nothing |
| [#789](https://github.com/cordel-app/gymdesk/issues/789) | ✅ done — cleanup keeps an opened request `pending`, so a member's payment is not lost |
| [#790](https://github.com/cordel-app/gymdesk/issues/790) | A back-dated `starts_at` yields a past first `next_billing_date`, charged one catch-up cycle per night |
| — | No reconciliation job against the provider. `POST /payments` (the staff ledger write) records a charge or a cash payment; nothing reads the provider back to confirm our rows agree with it. |

Production-readiness items (live credentials, Monei AoC, SRI for `monei.js`, the dedicated
`fitness-pay` VPS) are tracked in `docs/go-to-production.md` §5, not here.

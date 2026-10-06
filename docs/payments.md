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

- writes a `status_changed` Billing Event through `recordStatusChange()`
  (`api/src/api/billing-events.ts`), `previousStatus: null → 'draft'`;
- calls `snapshotAssignedPlan()` (`api/src/api/assigned-plan-snapshot.ts`) — the Assigned
  Plan owns the commercial configuration it was assigned with (#635 §11–§17).

What it does **not** write: `next_billing_date` (still NULL), a `payment_requests` row, or
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

Once active, the first payment is collected as A3–A6 describe, and nothing about it moves
`um.status`: the webhook's `completed` branch stamps `next_billing_date`, and the nightly run
skips the assignment until a card is on file. Stage 2 of #1108 is **Save & Pay** — the same
commit with the payment raised around it, a *Pending Payment* state between the two and the
forecast consolidated into real Billing Events — see
[Assigned Plan status model](#assigned-plan-status-model).

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
   `${PAYMENT_PAGE_URL}/checkout?token=<page_token>`.

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

The `completed` transaction (`webhooks.ts`, the `completed` branch):

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
   `updated_at`), and the **first `next_billing_date`** through
   `stampFirstNextBillingDate()` (`api/src/domain/nextBillingDateStamp.ts`): the **first
   cycle boundary strictly after UTC today** — `starts_at + n·cadence` for the smallest
   `n ≥ 1` whose date is later than `UTC_DATE()` (#790).

The boundary is computed by `firstBillingDateAfter()` (`api/src/domain/billingDate.ts`),
which steps with `advanceBillingDate()` — the same step the nightly run takes — so it is
always a date the run would itself reach from `starts_at` (31 Jan steps to 3 Mar, then
3 Apr). The schedule stays anchored to `starts_at`, so `classifyPlanDurationPeriod()`'s
Free/Paid/Bonus arithmetic is untouched; only the *first charge date* moves, and only
forward past today. For an assignment starting today or later that is exactly
`starts_at + 1 cadence`, as before. The cadence is `ASSIGNMENT_CADENCE`
(`api/src/api/assigned-plan-snapshot.ts`) — the assignment's frozen pair, its Plan's live
`billing_policies` row only as a fallback, hence the **LEFT** JOIN — and every date,
`UTC_DATE()` included, is read as a `YYYY-MM-DD` string from SQL, so none crosses a
timezone conversion. `WHERE next_billing_date IS NULL` means only the *first* payment
stamps it.

Why "strictly after today": the first payment is priced by `currentMembershipFee()` on
`currentCycleDate()`, which for a back-dated assignment with no `next_billing_date` is
**today**. Stamping `starts_at + cadence` (the pre-#790 SQL) put the next charge in the
past, so the run charged one elapsed cycle per night — and the last of them was the very
cycle the first payment had just been priced on, a double charge nothing could deduplicate.
A boundary *equal* to today would be charged by tonight's run for the same reason.

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
> - `ci.yml`, `deploy-alloy.yml` and `debug-vps.yml` stay on `dev`: CI needs no production
>   secret, and the other two are infrastructure/debugging tools.
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
Simulation, `GET /me/membership`, the Promotion apply/revoke adjustment and every staff
screen (through `currentMembershipFee()` / `currentMembershipFees()`). So what the run
charges cannot drift from what the member was shown.

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

**A Pre-paid Duration is charged, not waived (#946).** `resolveMembershipFee()` prices the
first period of an assignment's Pre-paid Duration at `regular x pay_beforehand_periods` — the
member pays those periods up front — and the periods it covers at 0 (`waived_billing`,
`notes 'prepaid_plan'`, exactly as before). So a cycle landing in that first prepaid period
takes the **Success** row of the table above with a multi-period amount
(`€70/month` x 3 pre-paid = `€210`, `5998`-style minor units at the provider boundary), and
every later prepaid cycle takes the **Waived** row. Nothing special-cases it in `billing.ts`:
the rule is `prepaidPeriodsDueOn()` in `api/src/domain/planDuration.ts`, read through the one
fee resolver, so a staff or member payment request, the Payments dashboard, My Membership and
the two Plan-card projections quote the same €210 for that cycle.
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
  use `POST /user-memberships/:id/reactivate`, which also walks a past `next_billing_date`
  forward to the first boundary after today (#790 — a pause is not a debt).

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

Answers `{ expired, expired_unopened, expired_abandoned, purchases_cancelled }`. **`expired` stays the total**,
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
   `payment_recorded` Billing Event is written with **no** `user_membership_id` (money did
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
  Every reader LEFT JOINs the assignment.
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
`user_memberships_status_check` CHECK (current definition: migration 227):

```
draft ──► active ◄──► paused
  └─────────┴───────────┴──► cancelled
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
>   `POST /:id/close`, which is warning-free because a Draft has never had a
>   `next_billing_date`.

`expired` is reached only by `assign-new-plan`'s supersede logic, never by request.

**Back to `active` (#790).** Both paths that move an existing assignment to `active` —
`POST /user-memberships/:id/reactivate` (`transitionMembership()`) and a `status` flip
through `PUT /user-memberships/:id` — do two things in the transaction that flips the
status: clear #785's dunning pair, and call `rollStaleNextBillingDateForward()`
(`api/src/domain/nextBillingDateStamp.ts`). If `next_billing_date <= UTC_DATE()` it is
walked forward along its own schedule, with the same `firstBillingDateAfter()` the first
payment uses, to the first boundary strictly after today. **A pause is not a debt**: the
cycles that went by while the assignment was off the run are not collected, one per night
or otherwise. A date still in the future is left alone, and a NULL one stays NULL — an
assignment that never paid has no schedule until its first payment stamps one. Pausing
never touches the date.

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
| `BILLING_INTERNAL_SECRET` | `/billing/run`, `/billing/cleanup` |
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
| When each nightly run last **completed**, and whether that is overdue | `GET /health/runs` (#782) — unauthenticated, read by two Grafana Cloud alert rules (below, #872) |

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
  (`grafanacloud-infinity`, backend parser) on `GET https://api.vdicube.com/health/runs` with
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
`starts_at + cadence` for a `starts_at` of today or later.

With a back-dated `starts_at`, expect instead the first `starts_at + n·cadence` **after**
today (#790) — never a date in the past — and the next run to charge nothing for it.

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
| — | No reconciliation job against the provider. `POST /payments` (the staff ledger write) records a charge or a cash payment; nothing reads the provider back to confirm our rows agree with it. |

Production-readiness items (live credentials, Monei AoC, SRI for `monei.js`, the dedicated
`fitness-pay` VPS) are tracked in `docs/go-to-production.md` §5, not here.

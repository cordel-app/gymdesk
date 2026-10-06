# Architectural Decisions

Short record of the settled choices that are not obvious from the code. Don't re-litigate these without a concrete reason — each one was made after weighing the alternative.

---

## 21. The GitHub Actions nightly runs are relayed by the admin app, behind an explicit path allowlist (#1086, 2026-10-06)

**Decision**: `.github/workflows/billing-run.yml` and `recurring-booking-run.yml` call the **admin app** — `https://admin.vdicube.com/api/internal/<path>` on dev, `https://admin.cordel.tech/api/internal/<path>` on pro — and that app relays each POST to the API's own route at `CORDEL_FITNESS_API_URL`. The relay is a Next route handler (`apps/admin/src/app/api/internal/[...path]/route.ts`) over a pure decision module (`apps/admin/src/lib/internalRunRelay.ts`) and a transport module (`lib/internalRunUpstream.ts`). `API_BASE_URL` keeps its name and holds the admin origin **plus the prefix**, so the workflows' own `$API_BASE_URL/billing/run` is unchanged.

**Why**: this is the third and last of the things that needed a public API (#1083 took Monei, #1085 Clerk). The admin app already fronts the API for every browser call, so a relay costs one route — but unlike those two, this one is reached by a caller with no signature to verify, so it carries an **explicit allowlist** of the four paths instead: `/billing/run`, `/billing/cleanup`, `/promotion-lifecycle/run`, `/recurring-bookings/run`.

**Consequences**:
- Neither internal secret leaves the API. The relay compares nothing: each router's `checkInternalSecret()` still answers the `401`, relayed as such, and it still spends #783's failed-secret budget.
- **The API's own status code and body are what the workflow gets**, byte for byte, because the workflows fail the job on a non-2xx *and* parse the counters out of the body (#778). Three statuses are the relay's own and none is a 200: **404** for a path outside the allowlist, **502**/**504** when it could not reach the API or the API outlived its timeout, **500** when `CORDEL_FITNESS_API_URL` is unset.
- The upstream call is **`node:http`, not `fetch`**. Node's global fetch abandons a response whose headers take more than 300 s, and `POST /recurring-bookings/run` is allowed 600 s by its workflow, so a long night would have been cut off at five minutes — and a run the API completed but the workflow saw as failed is the worst outcome available here, because #780's guard then refuses the retry as `already_completed_today`. The relay's own wait is `INTERNAL_RUN_RELAY_TIMEOUT_MS` (default 660 000 ms), deliberately above the longest `--max-time` in the workflows so `curl` is always the first to give up.
- `/api/proxy` is deliberately **not** reused: its header set is `authorization`, `x-gym-id`, `x-center-id`, `x-impersonate-as`, `x-locale` and the content type — a caller's own credentials, and not `x-internal-secret` — so a run sent through it would arrive unauthenticated, and widening that set would put the internal runners behind a route the browser app also uses. The relay's set is `x-internal-secret`, `content-type` and `x-forwarded-for`, declared once.
- The internal-run budget is keyed on the **client** address, through `internalRunClientKey()` (`api/src/domain/forwardedClient.ts`), which adds `INTERNAL_RUN_RELAY_HOPS` to `TRUST_PROXY_HOPS`. Keyed on the relay, ten wrong-secret guesses from anywhere would answer the nightly run `429` for the rest of the window — and only a 401 spends that budget, so the attack is cheap. The hop is declared per route and defaults to 0, not by raising `TRUST_PROXY_HOPS`, for #1083's reason.
- The path is exempt from `auth.protect()` **and** from the locale routing in `apps/admin/src/middleware.ts`, through the same early `return NextResponse.next()` the other two use.
- The nightly runs now depend on the **admin app** being up. A missed night is visible (both workflows raise `::error` on a failure) and #781's 10:00 UTC second attempt still covers the billing run; a missed booking night is recovered by the next one, because the run re-projects its window from *now*.
- Both GitHub environments' `API_BASE_URL` were repointed at the relay on 2026-10-05, so **the scheduled runs fail until an admin app carrying this route is deployed**. The owner steps — including when `INTERNAL_RUN_RELAY_HOPS` has to be `1` — are in `docs/go-to-production.md` §4b.
- With this deployed, nothing outside reaches the API's own host any more. Whether it is then actually closed off is the open question in **#1087**, which this ticket does not answer.

---

## 20. Clerk's webhook is relayed by the admin app, and the relay forwards rather than verifies (#1085, 2026-10-06)

**Decision**: Clerk posts its webhook to the **admin app** — `https://admin.vdicube.com/api/webhooks/clerk` on dev, `https://admin.cordel.tech/api/webhooks/clerk` on pro — and that app relays the request to the API's own `/webhooks/clerk` at `CORDEL_FITNESS_API_URL`. The relay is a Next route handler (`apps/admin/src/app/api/webhooks/clerk/route.ts`) over a pure decision module (`apps/admin/src/lib/clerkWebhookRelay.ts`).

**Why**: Clerk is the second of the three things that still needed a public API (#1083 took the first, #1086 the third). The admin app already fronts the API for every browser call through `/api/proxy`, so a relay costs one route; the **members** app would have done equally well — the two have identical middleware and proxy — and admin was chosen so there is one endpoint to keep in step with the Clerk dashboard rather than a choice to re-make.

**Consequences**:
- The webhook secret never leaves the API. `CLERK_WEBHOOK_SIGNING_SECRET` is unchanged by the move, `verifyWebhook()` is still the first operation of the API route over `express.raw`, and a tampered body is still a 400 **from the API**, relayed as such. The relay verifies nothing and knows nothing.
- **The API's status code is what Clerk gets**, never a blanket 200: Clerk retries exactly what we report as failed, and a swallowed `user.deleted` leaves an orphaned Clerk account linked to rows that should have been cleaned up (#709). An unreachable API is a **502** and an unset `CORDEL_FITNESS_API_URL` a **500** — both retried, and both replayable from the endpoint's *Replay → Replay missing messages*.
- The raw body crosses as **bytes** (`req.arrayBuffer()` in, the same buffer out) and the three `svix-*` headers byte for byte, because the signature is computed over `svix-id.svix-timestamp.<body>`. Anything that parsed and re-serialized the body would break a signature this app cannot recompute — #830's rule, applied to a request.
- `/api/proxy` is deliberately **not** reused: it forwards `authorization`, `x-gym-id`, `x-center-id`, `x-impersonate-as` and `x-locale` and none of the `svix-*` headers, so a webhook sent through it would reach the API unsigned. The relay's own set is the three Svix headers plus the content type, declared once, and no cookie, Authorization or `host` crosses the boundary.
- The path is exempt from `auth.protect()` **and** from the locale routing in `apps/admin/src/middleware.ts`, through the same early `return NextResponse.next()` `/api/proxy` uses — otherwise Clerk is answered with a 401 or a redirect to `/en/…`.
- The webhook now depends on the **admin app** being up. A missed delivery is retried by Clerk and replayable, and `user.created` keeps its `POST /staff/link` fallback at sign-in, so the worst case is a delay rather than a lost link.
- This covers Clerk only. The GitHub Actions nightly runs took the same shape in #1086 (see #21 above), after which the open question in #1087 is whether the API's host is closed off.

---

## 19. Monei's webhook is relayed by the payment app, and nginx is the runtime that relays it (#1083, 2026-10-06)

**Decision**: Monei posts its webhook to the **isolated payment app** — `https://pay.vdicube.com/webhooks/payment` on dev, `https://pay.cordel.tech/webhooks/payment` on pro (`PAYMENT_NOTIFICATION_URL`) — and that app relays the request to the API's own `/webhooks/payment` at its **internal** address. The relay is **nginx itself**, with one `location = /webhooks/payment` block: no Node process, no dependency and no new secret enters that container.

**Why**: it is the last thing the provider needed a public API for. nginx is already the payment app's runtime and already proxies two API paths for the browser (`/payment-page/`, `/themes/`), so a relay costs one block of configuration; a small Node server would be a second runtime to patch, and anything that parses and re-serializes the body would break the HMAC the API verifies over the exact bytes Monei signed.

**Consequences**:
- The webhook secret never leaves the API. The relay verifies nothing and knows nothing: `parseWebhook()` is still the first operation of the route, over `express.raw`, so a tampered body is still a 400 **from the API**, relayed as such.
- **The API's status code is what Monei gets.** `proxy_intercept_errors` stays off and the block contains no `return` and no `error_page`: a blanket 200 would lose a payment confirmation, since Monei retries exactly what we report as failed. An unreachable or slow API is a 502/504, which is a retry too.
- The API's `/webhooks/payment` is **one route behind one more proxy** than every other route, and its 60/min budget is keyed on the client. That extra hop is declared per route (`PAYMENT_WEBHOOK_RELAY_HOPS`, `api/src/domain/forwardedClient.ts`) and **not** by raising `TRUST_PROXY_HOPS`: a global raise would make Express trust one more caller-supplied `X-Forwarded-For` entry on every route that is still publicly reachable, letting a caller choose the bucket every per-IP limiter counts them in.
- Both API origins the payment image talks to are environment (`CORDEL_FITNESS_API_PUBLIC_URL`, `CORDEL_FITNESS_API_INTERNAL_URL`) rather than literals in the config, because one image tag serves dev and pro. The config is an `envsubst` template; the Dockerfile carries the dev values as image defaults so a container started with no environment behaves as before.
- The payment app still handles **no card data and no database**, so PCI scope is unchanged (#8): it relays one signed, opaque body.
- The payment container's own access log drops query strings (`log_format pay_no_query`), which is what the PCI note on this host already required for `?token=<page_token>`.
- This covers Monei only. Clerk's webhook took the same shape one app over in #1085 (see #20 above) and the GitHub Actions nightly runs in #1086 (see #21), after which the open question in #1087 is whether the API's host is closed off.

---

## 18. The Members App reaches the stores as a Capacitor shell; one generic app first, per-gym apps later (2026-10-04)

**Decision**: the iOS and Android app is a **Capacitor 8 shell that loads the deployed Members App** (`server.url`). There is no second front end and no React Native rewrite. **Stage 1 is one generic app, "Cordel Fitness"**, published by us; the gym's theme is applied after sign-in, as on the web. **Stage 2 is one app per gym**, built only when a gym asks for it, and it is designed for now: a gym app is another *profile* of the same shell, never a fork. Social sign-in inside the app is **native** (Google, and Sign in with Apple on iOS) and its ID token is handed to Clerk (`authenticateWithGoogleOneTap`); Clerk's default OAuth redirect is not used there. Bundle ID of the generic app: `com.cordel.fitness`.

**Why**: the UI already exists and is already responsive; a rewrite would double its maintenance for nothing the product needs yet. A feasibility spike (2026-10-04, iOS simulator) showed the shell works and that Clerk's default "Continue with Google" leaves the app for the system browser, so the session lands in Safari and never reaches the WebView, while the native Google token produces an active session inside the WebView that survives a restart. Google sign-in is a requirement, and a third-party login on iOS brings App Store guideline 4.8 (an equivalent privacy-preserving option), which is why Sign in with Apple is in scope. Push notifications are in scope because they are the clearest answer to guideline 4.2 (minimum functionality), not because Apple requires them.

**Consequences**:
- Everything native sits behind one module (`apps/member/src/lib/native.ts`, `isNative()`); a plain browser never runs it. The web bundle includes `@capacitor/core`: the native bridge alone does not provide `registerPlugin` to a remote page.
- The Google ID token's `aud` must be the **web** OAuth client (the one Clerk holds); the iOS/Android clients only identify the app.
- No app identity is hard-coded (Bundle ID, name, `server.url`, OAuth client IDs, Firebase config come from configuration), `member_device_tokens` carries an `app_id` from its first migration, and the association files list apps rather than one app — all so that stage 2 costs plumbing, not code.
- Stage 2 has two unverified risks that must be read before promising it to a gym: App Store guideline 4.2.6 (template apps may have to be submitted from the gym's own developer account) and whether Clerk accepts a native Apple token per Bundle ID.
- Sign in with Apple can return a private relay email that does not match the invited address, and `POST /me/link` matches by email + `gym_id`; how to link those members is an open decision (see `docs/mobile-app.md` WP3b).
- The shell is `apps/mobile` (WP3, #1074): one Capacitor workspace whose every identity value comes from an **app profile**
  (`profiles/<id>.json`, overridable per field by `MOBILE_*`), so "stage 2 costs plumbing, not code" is checked rather than intended —
  `api/src/test/mobile-shell-profile.unit.test.ts` fails on an identity literal anywhere else, and `npm run profile:apply` is the one
  writer of a native identity, because `cap sync` does not write one.
- Full plan, spike findings and work packages: `docs/mobile-app.md`. Manual simulator and device checks: `docs/mobile-runbook.md`. Launch checklist: `docs/go-to-production.md` §6.

---

## 17. Amounts cross the payment-provider boundary in minor units (#773, 2026-09-26)

**Decision**: every caller of `createPaymentRequest()` and `executeRecurring()` converts through `toMinorUnits()` (`api/src/payments/money.ts`). Everything on our side of that boundary — `user_memberships.membership_fee_price`, `billing_events.amount`, `payment_requests.amount`, what `resolveMembershipFee()` and `priceMembershipFeeOn()` return — stays a decimal number of euros.

**Why**: Monei's `/payments` takes cents, and the two sides had drifted. The nightly run and the staff Retry passed the euro amount straight through for as long as the provider was stubbed in tests, so a real renewal of a 29.99 € fee would have charged twenty-nine cents. One conversion helper at the one boundary is the only shape in which that cannot recur.

**Consequences**:
- Do not add a caller that passes euros to the provider, and do not add a provider adapter that expects them.
- A test of a provider call asserts the `amount` the stub received, not only that a call happened (`api/src/test/payments-money.test.ts`).
- The boundary is the provider, not the database: no column stores cents.

---

## 16. A failed internal charge is not reported to the member (2026-09-26)

**Decision**: when the nightly run cannot charge a member, the member is told nothing. The failure is a `failed_billing` Billing Event plus, on a rejection, #785's escalation to `paused`; surfacing it is a **staff** concern.

**Why**: the recurring charge is an unattended internal process, and a rejected card is a conversation between the gym and its member, not an automated dunning email from software the member never signed up to hear from. The gym decides what to say and when. It also avoids notifying a member about a `provider_error`, where the charge's outcome is unknown and may in fact have settled.

**Consequences**:
- No `member_notifications` type exists for a failed charge, and none should be added without a ticket that decides the wording and the trigger.
- The staff-side indicator is #779 (not built yet), and until it exists the only surfaces are Payments → Billing Events filtered by `failed`, the Members list's `payment_status`, and the red workflow run (#778).
- A member *can* see it indirectly on their own billing history, because the ledger is theirs to read — that is a read, not a notification.

---

## 15. The nightly runs stay on GitHub Actions (2026-09-26)

**Decision**: `POST /billing/run` and `POST /recurring-bookings/run` keep being triggered by scheduled GitHub Actions workflows. Rather than moving to a cron on the VPS or a hosted scheduler, the API and the workflows are made robust to the scheduler's weaknesses.

**Why**: GitHub Actions already holds the secrets, already has an audit trail per run, and already notifies on failure — a VPS cron has none of that and would be one more thing to deploy and monitor. Its real weakness is that `schedule` triggers are best-effort: they run late under load and are sometimes dropped entirely. That is fixable on our side.

**Consequences** — the hardening this decision commits to:
- **A red workflow is the notification** (#778): each workflow reads the response body, prints the counters, and exits non-zero on `failed > 0`, on an unreadable body, or on a non-2xx.
- **The run guard is a calendar rule, not a rolling window** (#780, migration 193): at most one *completed* run per UTC date, so a late cron cannot skip a day and a crash cannot lock one.
- **A second daily attempt** at 10:00 UTC for the billing run (#781), which is a green no-op on every day the 06:00 run completed. The recurring booking run deliberately keeps one schedule.
- **A freshness alert is still owed** (#782): no red run can report a day on which nothing reached the API at all, because there was no run.
- Because the schedule can fire twice, every run endpoint must stay idempotent under a second call on the same date — which is what the guard and `next_billing_date` together provide.

---

## 14. #503's 9-stage plan is complete, distinct from #360's own still-open stages (#503, 2026-09-18)

**Decision**: stage 9 ("Tests + docs") closes the 9-stage plan agreed on the #503 issue thread (stages 1–8: #568, #570, #572, #575, #576, #579, #580, #583). `calendar_events` is now the single occurrence entity for members and Admin alike: no `kind` discriminator, configurable waitlisting, activity→future-event field propagation, a unified member read model (`status`/`occupancy_status`/`waitlist_status`), local calendar filters, and a member calendar UI/Home/My Bookings that surface all of it.

- This is a separate, later staged plan from #360's own 5-stage CalendarEvent Unification plan (see #10 above and `docs/architecture.md`'s "Planned: CalendarEvent Unification" section) — both operate on `calendar_events`, but #360's plan is about *unifying it with `class_sessions`* and its own stages 4 (frontend consolidation) and 5 (cleanup/drop legacy tables) remain open. Closing #503 does not close #360.
- Two gaps were surfaced during this stage's audit and are deliberately **not** closed by it — they're open follow-up work, not silent regressions: (1) the `INNER JOIN activity_types` discovery gap noted in #11 above (occurrences with no activity type stay invisible to members); (2) the calendar detail panel has no explicit `Booked` badge (booking is currently implied only by which action button shows), while the ticket's "Event details" acceptance criteria call for it as a distinct, visible element the same way My Bookings already renders one.
- New test coverage added this stage: backend privacy/isolation regression tests (`api/src/test/member-calendar.test.ts`) proving no `/me/*` response can leak another member's booking identity and that one member's booking never flips another member's `availability_state`; and a Member app i18n key-parity test (`apps/member/src/test/locales.test.ts`, the app's first test file — `apps/member` gained a `vitest` devDependency and `test` script for it) proving every referenced translation key resolves in `en`/`es`/`ca`.

---

## 13. Member Notifications already existed before #503 asked for it (#503, 2026-09-18)

**Decision**: the #503 issue thread asked for "a section on top named 'Notifications'" in the Members app, assuming none existed. One already did — feature #194 (migration `087_member_notifications.js`, the `member_notifications` table, `sendNotification`/`sendBulkNotification` in `api/src/infra/notifications.ts`, the `/me/notifications*` endpoints, and the `/notifications` page) — and stage 4 (#575) was already writing `event_cancelled` notifications into it for schedule-rule cancellations. Stage 8 does not rebuild this feature; it only fixes the two things that made it not read as a working entry point: `TopBar.tsx` had no dedicated Notifications button (the unread dot sat on the Profile button, which links to `/profile`), and two notification types (`event_cancelled`/`event_updated`) had no i18n label in any locale, so they rendered as a raw type string.

- Before extending or "adding" a member-facing capability, check whether it already exists under a different issue number — `docs/architecture.md`'s feature list and a codebase search are cheaper than rebuilding.
- `apps/member/locales/base/*.json`'s `nav.alerts` key had been sitting unused since it was added; it's now wired to the new bell button rather than adding a duplicate key.

---

## 12. Waitlisting is configurable, and off for anything new (#503, 2026-09-18)

**Decision**: the waitlist is a three-state setting — `disabled` / `open` / `closed` — stored on `activity_types.waitlist_mode` with a nullable per-occurrence override on `calendar_events.waitlist_mode` (migration 154). The effective value is `COALESCE(ce.waitlist_mode, at.waitlist_mode)`, mirroring how `ce.capacity` falls back to `at.max_capacity`. Until now waitlisting was unconditional: every over-capacity booking silently became a waitlist row with no way to turn it off.

- A waitlist row is only ever created while the effective mode is `'open'` — this holds for both the automatic over-capacity fallback and a staff member's explicit `waitlist: true` request. Otherwise `bookMemberOnSession` returns 409 (`session_full_waitlist_not_open` / `waitlist_not_open`). Staff who need to seat someone past capacity use `force`, which books directly and never touches the waitlist.
- Promoting an already-waiting member when a booked slot frees up is deliberately **not** gated: `'closed'` means "not accepting new members", not "abandon the people already queued".
- The column default ends up `'disabled'`, per the issue thread ("the waitlist should be disabled by default"), but every pre-existing activity type lands on `'open'`: the migration adds the column with `DEFAULT 'open'` (one atomic DDL fills the existing rows) and only then flips the default. A separate `UPDATE` backfill would have been lost silently if the migration aborted after MySQL's implicit commit of the `ADD COLUMN`. Rows created under the old unconditional behavior keep it; only activity types created from here on start with no waitlist. Tests that exercise waitlisting must now ask for `'open'` explicitly.
- Writing the per-occurrence override is not exposed by the admin API yet — it is read and honored, and the activity-level setting is what the admin UI edits. A later #503 stage owns per-occurrence editing along with propagating activity changes to future events.

---

## 11. Drop the calendar_events.kind discriminator (#503, 2026-09-17)

**Decision**: the `kind ENUM('session','event')` column added by the #360 unification (migration 134) is removed (migration 152). Every `calendar_events` row is now equally bookable at the primitive/API level — `bookMemberOnSession` no longer gates on `kind`. This was requested explicitly on the #503 issue thread: "There must be no separate logic for sessions versus events."

- The admin-facing `classSessionsRouter`/`calendarEventsRouter` split (`calendar-events.ts`) is **not** merged by this decision — it now partitions `calendar_events` by `activity_type_id` (`IS NOT NULL` vs `IS NULL`) instead of `kind`, preserving the same mutually-exclusive split the admin Calendar page's dual-fetch relies on. Fully merging the two admin detail panels (`ClassSessionDetailPanel` vs `EventDetailsPanel`) into one UI is an open design question, not yet specified, left for a later #503 stage.
- Member-facing discovery (`/me/schedule`, `/me/upcoming`, `/me/activity-history`) still implicitly requires `activity_type_id IS NOT NULL` (via `INNER JOIN activity_types`) — extending it to rows without an activity type was flagged for "Unified member read model" (stage 5, #576), but that stage scoped itself to additive read-model fields only and explicitly left the join as-is (see its own PR's "Scope note"). **This gap is still open as of stage 9** — it was never closed by any of the 9 stages — and is tracked here rather than only in `docs/architecture.md`'s roadmap paragraph, so it isn't mistaken for resolved.
- Do not reintroduce a session/event (or similar) discriminator column as a workaround for admin UI branching — that was explicitly ruled out on the issue thread. If the admin UI split needs its own signal going forward, that's a product decision to make explicitly, not to infer from a renamed flag.

---

## 10. CalendarEvent unification — design decisions (#360, 2026-09-06)

**Decision**: `class_sessions` (with its `bookings`, waitlist, attendance, and package-credit integration) will be unified onto `calendar_events` as the single canonical scheduled/bookable entity — see [architecture.md](architecture.md)'s "Planned: CalendarEvent Unification" section for the target shape. This entry settles the three open questions from the #360 clarification thread; it does not itself implement the migration.

- `calendar_event_series` (added in #191, migrations 083–085) will be dropped. It has zero references in application code — recurrence already runs through the separately-built `activity_type_schedule_rules` mechanism — so it never became the source of truth it was designed to be.
- `activity_type_schedule_rules` remains the one recurrence mechanism going forward; `calendar_events` continues to be materialized from it via `domain/scheduleEngine.ts`.
- The cutover will be a hard cutover, not a dual-write/backfill migration: there is no production data in the scheduling/booking tables that needs to be preserved, so schema and code can move directly to the unified model and any existing non-production rows can be cleared as part of the migration.

**Why**: gym scheduling currently has two asymmetric implementations — `class_sessions`+`bookings` is the feature-rich booking engine (waitlist, attendance, package credits, shared-training approvals; ~13 backend files), while `calendar_events` is a thin scheduling entity with no booking/attendance/capacity support (`event_bookings` was built once and fully dropped in migration 095, see #9 below). The admin Calendar page's dual-fetch-and-merge of both tables (#326) is documented as intentional but is a stopgap, not a target state.

**Consequences**:
- Do not build new booking/attendance/capacity features on `class_sessions` — new work in this area should target the design in architecture.md's CalendarEvent Unification section instead.
- The unification is staged as 5 PRs (design → schema+booking support on `calendar_events` → API consolidation → frontend consolidation → cleanup); see #360 for tracking. Stage 1 (design, this decision + the architecture.md design section) and stage 2 (schema — `capacity`/`allows_shared_booking`/`cancellation_reason`/`effective_trainer_membership_id`/`effective_trainer_confirmed_at` on `calendar_events`, plus the new `calendar_event_bookings` and `calendar_event_shared_training_requests` tables, migrations 131–133) have landed. No application code reads or writes the new columns/tables yet.
- Existing `class_sessions`/`bookings` endpoints and the admin Calendar page's dual-fetch behavior are unaffected until the API consolidation stage lands.

---

## 9. No standalone Event entity (#221, 2026-08-05)

**Decision**: the `events` and `event_bookings` tables, all related API endpoints, and all frontend surfaces were permanently removed. Any scheduled occurrence must be represented as a Calendar item (using `calendar_events`) with an appropriate type — not as a new standalone entity.

**Consequences**:
- Do not reintroduce `Event` as a standalone entity. If differentiation is needed (workshop, appointment, special activity), differentiate through existing columns (e.g. `activity_type_id`) rather than creating a new table — see #11 above, which additionally rules out a dedicated discriminator *column* for this on `calendar_events`.
- `GET /me/upcoming` and `GET /me/activity-history` return bookings for occurrences of an activity type (`activity_type_id IS NOT NULL`) — in practice every booking today, since `bookMemberOnSession` requires the caller to reach the occurrence through `/me/schedule`, which has the same requirement (see #11). This is a `calendar_events` discovery gap, not a standalone-Event concept — see #11's stage 9 note.
- **Stale as of #503 stage 4 (#575):** this bullet previously said the `member_notifications` table's `event_cancelled`/`event_updated` type values were "dead historical rows" that would never be written again. That stopped being true once stage 4 started writing `event_cancelled` notifications for schedule-rule/end-date cancellations, and stage 8 (#583) added the missing `en`/`es`/`ca` labels for both types specifically because they're live again. These two types are active, current calendar-event notifications now — not #221's removed standalone Event entity — and should keep working.

---

## 1. MySQL 8 (Oracle HeatWave) over PostgreSQL

**Decision**: migrated from Neon Postgres to Oracle HeatWave MySQL (Phase M, 2026-07-03, ~€50/mo).

**Why**: predictable pricing (Neon's serverless billing was unpredictable at scale), single-vendor infra with the VPS (Oracle OCI), and HeatWave's OLAP capabilities for future analytics without a separate data warehouse.

**Consequences that affect everyday coding**:
- No `RETURNING` — insert then SELECT by `insertId`
- No partial/filtered indexes — use a generated column + unique index for "unique among active rows"
- DDL is non-transactional — keep migrations small and guard ALTERs with `hasColumn`
- Use `UTC_TIMESTAMP()`, never `NOW()`; `VARCHAR` not `TEXT` for indexed columns

---

## 2. Clerk for authentication (not custom auth)

**Decision**: Clerk handles all authentication — sign-up, sign-in, JWT issuance, invitation emails.

**Why**: eliminates the token/session/password infra entirely. The only auth-related code in this repo is `requireAuth()` (verifies the JWT) and `tenantContext` (maps Clerk userId → gym role). Invitation flows use Clerk's invitation API so we never store passwords or handle email delivery ourselves.

**Consequences**:
- Every user (staff, member, coach) must arrive via invitation — **Restricted mode must be ON** in the Clerk dashboard for every instance (dev + prod). This is a manual dashboard toggle, not enforceable from code.
- Use `req.auth.userId` in route handlers. Never call `getAuth()` — it caused a 500 in the invite activation flow.
- Superadmin role is stored in Clerk `publicMetadata.platform_role`, not in the DB.

---

## 3. No ORM (raw SQL via mysql2)

**Decision**: all queries are raw SQL through the `db.query` / `db.transaction` helpers in `api/src/infra/db.ts`. No Prisma, Sequelize, TypeORM, or Drizzle.

**Why**: the team is comfortable with SQL; ORMs add a mapping layer that obscures multi-tenant filtering bugs (a missing `gym_id` filter is obvious in raw SQL, invisible in an ORM scope). Raw SQL also makes migration-to-query pairing explicit.

**Consequences**: every query must manually include `AND gym_id = ?`. Use `db-helpers.ts` (`gymFetchOne`, `insertAndFetch`, `handleDupEntry`) to reduce boilerplate on standard CRUD.

---

## 4. Internal billing ledger first; MONEI as the active payment provider (Phase 8)

**Decision**: payments are staff-recorded via the `billing_events` append-only ledger. Online payment processing uses **MONEI** as the PSP (replacing the earlier Stripe/Paycomet candidates). Gymdesk owns all subscription logic; MONEI only stores payment tokens and executes charges.

**Why**: real gyms run on cash/transfer for a long time. Building the ledger first means members and staff get a working payment history and the data model is stable before PSP complexity is added. MONEI was chosen over Stripe and Paycomet for its simpler Spanish-market integration and better MIT (Merchant-Initiated Transaction) support.

**Consequences**:
- `billing_events` is append-only (no updates, no deletes). Status changes emit a `status_changed` system event in the same transaction.
- All PSP integrations write into the same ledger with `provider: 'monei'` (or future provider name).
- The payment provider abstraction lives in `api/src/payments/` — never import from `providers/monei/` directly in route handlers; always use `getPaymentProvider()`.
- Card tokenization stores `payment_token` + `sequence_id` (Monei MIT fields) in the generic `payment_methods` table. Unused fields remain NULL for future providers.
- `sequenceType: 'first'` must be set on initial card registration; `sequenceType: 'recurring'` on all subsequent MIT charges (card scheme requirement).

---

## 5. Center as the single location concept (not gym_locations)

**Decision**: `centers` (Phase 9, #59) is the only location entity. The earlier `gym_locations` design (Phase 7, #39–#41) was never built and is closed.

**Why**: `gym_locations` had a nullable-FK design that made tenant isolation harder. `Center` is `gym_id`-scoped from creation, and `Gym` remains the tenant boundary. Every existing gym auto-received one default Center.

**Consequences**: multi-location features scope to `center_id`. Single-center gyms never need to set `x-center-id` — `resolveCenterId()` falls back to the sole active center automatically.

---

## 6. Fire-and-forget audit logging

**Decision**: `recordAudit()` never throws into the calling request. A failed audit INSERT logs to `console.error` and is silently dropped.

**Why**: an audit write failure should never block a legitimate business write (e.g., a member update). Audit integrity is best-effort, not a hard guarantee.

**Consequences**: don't wrap `recordAudit` in try/catch in route handlers — it handles its own errors. Don't rely on audit rows being present in tests that fire immediately after a write (slight async gap).

---

## 7. No microservices, no event sourcing, no AI/LLM

**Decision**: one Express process, one MySQL database, synchronous request handling throughout.

**Why**: the product is a SaaS for small-to-medium gyms. Operational complexity of microservices or event stores would outweigh any benefit at this scale. AI/LLM integrations are explicitly excluded — the product is a management tool, not a recommendation engine.

**Consequences**: new features go into `api/src/api/` as a new router file. Shared logic goes into `api/src/infra/` or `api/src/domain/`. Never reach for a queue, a separate service, or an external AI API.

---

## 8. PCI scope isolation — isolated payment page container

**Decision**: card entry happens exclusively on a separate container (`fitness-pay`, `pay.vdicube.com`) that is completely isolated from the main API, admin app, and member app.

**Why**: by hosting the Monei Card Input iframe on a dedicated origin with no server-side business logic, we reduce PCI DSS scope to SAQ A (the simplest tier). Card data never touches Gymdesk servers.

**Consequences**:
- `apps/payment/` is a new app in the monorepo: static HTML/JS/CSS only, served by nginx, no Node.js runtime.
- **No JavaScript frameworks** in `apps/payment/` — vanilla only. No React, no Angular, no jQuery. The only external script is `https://js.monei.com/v2/monei.js`.
- `fitness-pay` is the fourth Podman container on corfront, alongside `fitness-admin` and `fitness-members`.
- The only bridge the **browser** has to the main API is `GET /payment-page/token/:token` — a read-only, unauthenticated, rate-limited endpoint that returns display fields only (amount, gymName, memberName). The token is a UUID v4, single-use, 10-minute TTL. Since #1083 the container also relays Monei's webhook server-side (#19); it still reads no card data and no database.
- `MONEI_ACCOUNT_ID` (public key) is the only Monei config baked into the payment page. `MONEI_API_KEY` and `MONEI_WEBHOOK_SECRET` never leave the API container.
- **PCI DSS v4.0 Req 6.4.3**: every third-party script on the payment page must have an SRI hash and be in a maintained inventory (`apps/payment/SCRIPT-INVENTORY.md`). Contact Monei for a versioned URL + `sha384` hash before go-live. If unavailable, a real-time page-integrity monitoring service (e.g. c/side, Reflectiz) is the compensating control.
- **Monei AoC**: Monei's current Attestation of Compliance must be obtained before production go-live. SAQ A eligibility is void without it.
- **MIT consent**: the member must explicitly acknowledge recurring billing terms before the first CIT (captured in `payment_requests.consent_given_at`). Required by Visa/Mastercard card scheme rules.
- **Dedicated VPS (recommended, deferred)**: for full PCI network isolation `fitness-pay` should run on its own VPS, not on the same host as `fitness-members`. The shared corfront deployment is an accepted risk with compensating controls (separate container, distinct port, no shared secrets). Migration to a dedicated VPS should be done before any formal QSA assessment.


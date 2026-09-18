# Architectural Decisions

Short record of the settled choices that are not obvious from the code. Don't re-litigate these without a concrete reason — each one was made after weighing the alternative.

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
- Member-facing discovery (`/me/schedule`, `/me/upcoming`, `/me/activity-history`) still implicitly requires `activity_type_id IS NOT NULL` (via `INNER JOIN activity_types`) — extending it to rows without an activity type is explicitly a later stage of the #503 plan ("Unified member read model"), not part of this decision.
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
- `GET /me/upcoming` and `GET /me/activity-history` return bookings for occurrences of an activity type (`activity_type_id IS NOT NULL`) — in practice every booking today, since `bookMemberOnSession` requires the caller to reach the occurrence through `/me/schedule`, which has the same requirement (see #11).
- The `member_notifications` table retains the `event_cancelled`/`event_updated` type values as dead historical rows; no new notifications of those types will be written.

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
- The only bridge to the main API is `GET /payment-page/token/:token` — a read-only, unauthenticated, rate-limited endpoint that returns display fields only (amount, gymName, memberName). The token is a UUID v4, single-use, 10-minute TTL.
- `MONEI_ACCOUNT_ID` (public key) is the only Monei config baked into the payment page. `MONEI_API_KEY` and `MONEI_WEBHOOK_SECRET` never leave the API container.
- **PCI DSS v4.0 Req 6.4.3**: every third-party script on the payment page must have an SRI hash and be in a maintained inventory (`apps/payment/SCRIPT-INVENTORY.md`). Contact Monei for a versioned URL + `sha384` hash before go-live. If unavailable, a real-time page-integrity monitoring service (e.g. c/side, Reflectiz) is the compensating control.
- **Monei AoC**: Monei's current Attestation of Compliance must be obtained before production go-live. SAQ A eligibility is void without it.
- **MIT consent**: the member must explicitly acknowledge recurring billing terms before the first CIT (captured in `payment_requests.consent_given_at`). Required by Visa/Mastercard card scheme rules.
- **Dedicated VPS (recommended, deferred)**: for full PCI network isolation `fitness-pay` should run on its own VPS, not on the same host as `fitness-members`. The shared corfront deployment is an accepted risk with compensating controls (separate container, distinct port, no shared secrets). Migration to a dedicated VPS should be done before any formal QSA assessment.


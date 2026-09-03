# Gymdesk Architecture

## TL;DR (read this first, skip the rest for small tasks)

**Stack**: Express API (`api/`) · Next.js admin app (`apps/admin/`, port 8081) · Next.js member PWA (`apps/member/`, port 8082) · MySQL 8 (HeatWave in prod, schema `fitness`) · Clerk auth.

**Tenant isolation**: every domain table has `gym_id`. Every query filters by it. The `x-gym-id` request header carries the active gym; `tenantContext` middleware resolves it and attaches `req.tenantCtx`.

**Auth**: `requireAuth()` verifies the Clerk Bearer token → `userId` on `req.auth`. `tenantContext` then resolves the gym role from `gym_memberships`. Use `requireModuleAccess(module)` / `requireModuleWrite(module)` to gate at the router-mount and write-route level respectively. Use `requireRole('admin')` only for explicit last-admin guards or superadmin operations. Never use `getAuth()` — use `req.auth`.

**Roles**: `guest` (public) · `member` · `nutritionist` · `accountant` · `front_desk` · `trainer_performance` · `trainer_perf_nutrition` · `admin` (gym-scoped) · `superadmin` (platform, Clerk metadata).

**DB conventions**: auto-increment `INT UNSIGNED` PKs, `CHAR(36)` UUID for `gyms`, `UTC_TIMESTAMP()` not `NOW()`, `VARCHAR` not `TEXT` for indexed columns, soft-delete via `deleted_at DATETIME`, named CHECK constraints for statuses, no `RETURNING` (insert then SELECT by `insertId`), `db.transaction()` for multi-statement writes.

**Frontend**: all requests go through `apiFetch()` → `/api/proxy/` (Next.js proxy, Node runtime) → backend. Admin app uses `useGym()` / `GymContext`; member app uses `useApp()` / `AppContext`. Sidebar is config-driven via `config/navigationGroups.ts` — add nav items there, not in JSX.

**Reference implementations**: Members (staff-level CRUD + soft-delete) · Plans (`api/src/api/membership-plans.ts`, admin-only CRUD). Copy one of these for new features.

**Architectural decisions**: see `docs/decisions.md` for the settled choices (MySQL, Clerk, no ORM, etc.) — don't re-litigate them.

---

## Overview

Multi-tenant Gym Management SaaS. One Express backend, two Next.js frontends (admin + member), one MySQL 8 database (Oracle HeatWave in deployed environments; schema `fitness`). Authentication via Clerk. Tenant isolation via `gym_id` on every domain table and the `x-gym-id` request header.

The domain now spans membership plans & billing, classes & scheduling, class packages/credits, promotions, workouts & training plans, team management, per-gym theming, and an audit log. See `docs/roadmap.md` for phase status.

---

## Monorepo Layout

```
gymdesk/
  api/src/                         # Express API (shared by both frontends)
    index.ts                       # App entrypoint, route registration, requireAuth()
    api/                           # One file per domain (members.ts, class-sessions.ts, …)
    lib/
      logger.ts                    # pino singleton (LOG_LEVEL env var; pino-pretty in dev)
    middleware/
      requestLogger.ts             # pino-http middleware — stamps requestId on req.log
    domain/types.ts                # Shared TypeScript interfaces
    infra/
      db.ts                        # mysql2 pool + query/transaction helpers
      tenantContext.ts             # Middleware: resolves gym role, requireRole(), requireSuperadmin
      audit.ts                     # recordAudit() — fire-and-forget audit_logs writer
      migrations/                  # Knex migration .js files (001_ … 052_)
      swagger.ts                   # OpenAPI spec served at GET /docs
      seed.ts                      # Dev seed (sets a Clerk user as platform superadmin)
    payments/                      # Payment provider abstraction layer (#179)
      types.ts                     # Shared value types (PaymentStatus, CreatePaymentRequestParams, …)
      provider.ts                  # PaymentProvider interface (createPaymentRequest, parseWebhook, executeRecurring)
      index.ts                     # getPaymentProvider() factory — reads PAYMENT_PROVIDER env var, caches singleton
      providers/
        monei/
          index.ts                 # MoneiProvider implements PaymentProvider
          client.ts                # fetch wrapper for https://api.monei.com/v1
          webhook.ts               # HMAC-SHA256 signature verification (timingSafeEqual first) + payload mapping
          types.ts                 # Monei-specific internal types
  apps/
    admin/src/                     # Staff/admin Next.js app (port :8081 both locally and deployed)
      app/[locale]/                # Next.js App Router pages (one folder per domain)
      components/                  # DataTable, CrudModal, ConfirmDialog, StatusBadge, StatusFilter,
                                   #   Toast, Sidebar, NavGroup, AppShell, TopHeader, GymSelector,
                                   #   LanguagePicker, ThemeProvider, ui.tsx
      config/navigationGroups.ts   # Sidebar structure: collapsible groups + role gating
      context/GymContext.tsx       # Active gym, role, isSuperadmin — loaded everywhere
      lib/apiClient.ts             # apiFetch() — attaches Bearer token + x-gym-id
      middleware.ts                # Clerk auth + next-intl locale routing
      locales/base/{en,es,ca}.json
    member/src/                    # Member-facing PWA (port :8082 both locally and deployed)
      app/[locale]/                # Public home, sign-in, schedule, membership, training
      app/api/proxy/[...path]/     # Proxy → backend (Node runtime — edge fetch can't reach port 3000)
      components/BottomNav.tsx      # Mobile bottom navigation
      context/AppContext.tsx        # gymId + linked member profile
      lib/apiClient.ts
      middleware.ts                # Public routes: /, /:locale, /classes, /sign-in, /api/proxy
      locales/base/{en,es,ca}.json
  shared/                          # Placeholder for future shared services (currently empty)
  docs/                            # This folder
```

---

## Authentication & Authorization

### Auth (Clerk)
- `requireAuth()` in `index.ts` verifies the Clerk Bearer token on every protected route.
- Decoded `userId` is attached as `req.auth.userId`.
- **Required Clerk instance setting: Restricted mode.** Every user in this app — Members and Team roles alike — is meant to arrive via an invitation, never public self-registration. In the Clerk Dashboard, this is `Configure → Protect → Restrictions → Enable restricted mode`, and it must be **on** for every instance (dev + production). This is a dashboard-only toggle, not exposed via the Backend API (`GET`/`PATCH /instance` and `/instance/restrictions` only cover allowlist/blocklist and other flags — no sign-up-mode field), so it can't be enforced from code and isn't covered by CI. With it off, anyone can self-serve sign up with any email at `/sign-up`, independent of invitation state — see the Team invite flow note below for why that matters.

### Tenant context (`infra/tenantContext.ts`)
- Reads the `x-gym-id` header, looks up `gym_memberships` to get the user's `role` in that gym.
- Attaches `req.tenantCtx = { userId, gymId, role, gymMembershipId, isSuperadmin, actorName }`. `actorName` is derived from the Clerk user object already fetched in this middleware and stored for use by `recordAudit` (no extra query).
- Helper `getTenantContext(req)` retrieves it safely inside route handlers.
- Superadmins (Clerk metadata) are granted a synthetic `admin` role for any gym without a membership row.

### Roles

`AppRole` (the DB-backed role type, from `api/src/infra/permissions.ts`) is `admin | trainer_performance | trainer_perf_nutrition | front_desk | accountant | nutritionist | member`. `superadmin` is a **platform** role stored in Clerk, not a `gym_memberships` value. `guest` is anonymous (public routes only). Migration 075 renamed `coach → trainer_performance` and `staff → front_desk` and added 3 new roles.

| Role | Scope | Who | How identified |
|------|-------|-----|----------------|
| `superadmin` | Platform | Cordel internal | Clerk `publicMetadata.platform_role === 'superadmin'` |
| `admin` | Gym | Gym/studio owner | `gym_memberships.role` |
| `trainer_performance` | Gym | Performance trainer | `gym_memberships.role` |
| `trainer_perf_nutrition` | Gym | Trainer + nutrition | `gym_memberships.role` |
| `front_desk` | Gym | Receptionist | `gym_memberships.role` |
| `accountant` | Gym | Accountant | `gym_memberships.role` |
| `nutritionist` | Gym | Nutritionist | `gym_memberships.role` |
| `member` | Gym | Gym member/client | `gym_memberships.role` + `members.clerk_user_id` |
| `guest` | Public | Anonymous visitor | No auth — `/public/*` routes only |

### Permission model (#156)

Access is governed by a static `PERMISSION_MATRIX` in `api/src/infra/permissions.ts` (mirrored to `apps/admin/src/config/permissions.ts` for the frontend). Each cell maps `AppModule × AppRole → PermissionLevel` (`RW | R | R_ASSIGNED | RW_ASSIGNED | R_OWN | NONE`). R_ASSIGNED/RW_ASSIGNED are treated as R/RW at the router layer until a `staff_member_assignments` table is added.

| Module | admin | trainer_performance | trainer_perf_nutrition | front_desk | accountant | nutritionist | member |
|---|---|---|---|---|---|---|---|
| MEMBERS | RW | R_ASSIGNED | R_ASSIGNED | RW | R | R_ASSIGNED | R_OWN |
| ORGANIZATION | RW | NONE | NONE | R | NONE | NONE | NONE |
| TRAINING | RW | RW_ASSIGNED | RW_ASSIGNED | R | NONE | NONE | R_OWN |
| NUTRITION | RW | R | RW_ASSIGNED | R | NONE | RW_ASSIGNED | R_OWN |
| FINANCIALS | RW | NONE | NONE | NONE | RW | NONE | NONE |
| PAYMENTS | RW | NONE | NONE | RW | RW | NONE | NONE |
| SYSTEM | RW | NONE | NONE | NONE | NONE | NONE | NONE |
| CORDEL | NONE | NONE | NONE | NONE | NONE | NONE | NONE |

Routers are mounted with `requireModuleAccess(module)` (non-NONE, non-R_OWN gate); write routes inside them add `requireModuleWrite(module)` (RW or RW_ASSIGNED). Use `requireRole('admin')` only for explicit last-admin guards or admin-only operations within a module.

| Domain (router) | Module gate | Write guard | Notes |
|---|---|---|---|
| Members (`members`) | MEMBERS | `requireModuleWrite('MEMBERS')` | Soft-delete + `/restore`; DELETE = `requireRole('admin')`. |
| Team (`gym-users`) | ORGANIZATION | `requireRole('admin')` | Entire CUD is admin-only. |
| Spaces, Specialities, Activity types, Class packages, Events, Trainers | ORGANIZATION | `requireRole('admin')` or `requireModuleWrite('ORGANIZATION')` | Admin-only writes. |
| Class sessions (`class-sessions`) | TRAINING | `requireModuleWrite('TRAINING')` | `POST /:id/cancel` also write-gated. |
| Bookings (`bookings`) | MEMBERS | `requireModuleWrite('MEMBERS')` | `POST /:id/attendance` = `requireRole('admin','front_desk','trainer_performance','trainer_perf_nutrition')`. `POST /bookings` accepts `force=true` for over-capacity walk-ins. Class-session attendance endpoints (`bulk-present`, `effective-trainer`, `complete`) use `requireRole` or `requireModuleWrite('TRAINING')`. |
| Exercises, Workout templates, Training plan templates | TRAINING | `requireModuleWrite('TRAINING')` | `POST /exercises/import-defaults` seeds a per-gym catalog. Deletes are soft (#62). |
| Training plans (`training-plans` + `members/:id/…`) | TRAINING | `requireModuleWrite('TRAINING')` | See personalized plans notes (migration 054, 066). |
| Nutrition Library (`nutrition-library`) | NUTRITION | read: `requireModuleAccess('NUTRITION')`, no writes | `nutrition_library_items` has `gym_id CHAR(36) NULL` (migration 103 — NULL = Cordel-owned base item), `status VARCHAR(20) DEFAULT 'active'`, `modified_at`. Functional unique index `COALESCE(gym_id,'')` handles NULL-safe uniqueness. 32 seeded items, 6 categories. `GET /nutrition-library?category=`. Platform CRUD at `/platform/nutrition-library` (`requireSuperadmin`). |
| Nutrition plan templates | NUTRITION | `requireModuleWrite('NUTRITION')` | `nutrition_plan_templates.gym_id` is nullable (migration 103 — NULL = Cordel base template). `cloned_from_id INT UNSIGNED FK→self` tracks lineage. `GET /nutrition-plan-templates?type=base\|gym\|all`; `owner_type` field on every row. `POST /:id/clone` deep-copies any template → gym-owned draft. `POST /:id/assign` (body: `{member_id, start_date}`) deep-clones → `member_nutrition_plans`. Platform CRUD at `/platform/nutrition-plan-templates` (`requireSuperadmin`). |
| Member nutrition plans (`member-nutrition-plans`) | NUTRITION | `requireModuleAccess('NUTRITION')` | Created via `POST /nutrition-plan-templates/:id/assign`. Tables: `member_nutrition_plans` → `member_nutrition_plan_days` → `member_nutrition_plan_meals` + `member_nutrition_plan_meal_items` + `member_nutrition_plan_restrictions` + `member_nutrition_plan_goals` (all with `gym_id`). `GET /member-nutrition-plans?member_id=`, `GET /:id`, `GET /:id/hierarchy`, `DELETE /:id` (soft-delete). |
| User memberships (`user-memberships`) | PAYMENTS | `requireModuleWrite('PAYMENTS')` | DELETE = `requireRole('admin')`. Status changes emit billing events. |
| Billing ledger (`billing-events`) | PAYMENTS | `requireModuleWrite('PAYMENTS')` | Append-only. |
| Payments (`payments`) | PAYMENTS | `requireModuleWrite('PAYMENTS')` | Operational view; excludes `status_changed`. |
| Payment requests (`payment-requests`) | PAYMENTS | `requireModuleAccess('PAYMENTS')` write: `requireModuleWrite('PAYMENTS')` | Admin/staff-initiated payment requests. MONEI flow: creates `payment_requests` row + page_token (10-min TTL). Member self-service: `GET/POST /me/payment-requests` (rate-limit POST 3/hour per Clerk userId). |
| Payment page token (`payment-page`) | none | none (token auth) | No Clerk auth. `GET /payment-page/token/:token` — single-use lookup consumed immediately (page_token set to NULL on read). Used by the isolated `pay.vdicube.com` app. Rate-limited 20/min per IP. |
| Payment webhooks (`/webhooks/payment`) | none | HMAC-SHA256 (Monei signature) | Mounted before `express.json()` with `express.raw`. Fail-fast: `parseWebhook()` verifies HMAC as first op; returns 400 on invalid sig (no DB queries). On success: updates `payment_requests`, inserts `billing_events`, upserts `payment_methods`. Idempotent. Rate-limited 60/min per IP. |
| Internal billing cleanup (`/billing/cleanup`) | none | `X-Internal-Secret` header | POST expires stale pending payment_requests. Called by nightly billing workflow. |
| Internal billing run (`/billing/run`) | none | `X-Internal-Secret` header | POST fires nightly MIT recurring charges. Rate-limited: rejects with 429 if last successful run was <23 h ago (enforced via `billing_run_log` singleton). Queries active memberships with `next_billing_date <= UTC_DATE()` (INNER JOIN `payment_methods`). For each: calls `getPaymentProvider().executeRecurring()`, inserts a `payment_requests` row (`source='billing_run'`) for auditability, inserts `billing_events` (`recurring_payment` on success, `failed_billing` on failure), advances `next_billing_date` (computed in JS via `advanceBillingDate()` — avoids MySQL INTERVAL unit parameterization). Called by `.github/workflows/billing-run.yml` at 06:00 UTC. |
| Membership plans, Benefit types, Charge types, Promotions | FINANCIALS | `requireRole('admin')` | Admin-only within FINANCIALS module. |
| Tax Rates (`taxes`) | FINANCIALS | read: any FINANCIALS role; write: `requireRole('admin')` | Per-gym tax rate catalogue (migration 112). One `is_system=1` "Standard VAT 21%" row auto-seeded per gym at creation. Custom rates: full CRUD with soft-delete. `tax_behavior` on `gym_charges` ('inclusive'/'exclusive') controls whether `amount` is gross or net. `computePriceFields()` in `sellable-items.ts` derives `amount_excl_tax`/`amount_incl_tax`/`applied_tax_rate`. `tax_rate_id FK→tax_rates` on both `gym_charges` and `membership_plans`. |
| Audit log (`audit-logs`) | SYSTEM | — | Read-only; `?scope=all` for superadmin. |
| Themes (`/system/themes`) | SYSTEM | — | R/W within SYSTEM module. |
| Action types (`action-types`) | any role | — | Global lookup (no `gym_id`), seeded in migration. |
| Public (`public/*`) | guest | — | Gym landing + class list by slug. |
| Platform (`platform/*`) | `superadmin` | `superadmin` | Gym creation/list; superadmin management. |

Usage in routes:
```ts
// In app.ts — module-level read gate at mount:
app.use('/members', requireAuth(), tenantContext, requireModuleAccess('MEMBERS'), membersRouter);

// In a router — write gate on individual mutations:
router.post('/', requireModuleWrite('TRAINING'), handler);
router.delete('/:id', requireRole('admin'), handler);  // explicit last-admin guard

// Public routes — no middleware at all:
app.use('/public', publicRouter);
```

Trainers are `trainer_performance` or `trainer_perf_nutrition` rows in `gym_memberships`; the `trainers` router surfaces them for assignment to class types and sessions.

### Platform superadmin (Clerk metadata)
- `requireSuperadmin` middleware checks `user.publicMetadata.platform_role === 'superadmin'`.
- Used for `/platform/*` (gym creation, full gym list) and `/platform/superadmins` (grant/revoke platform role).
- `tenantContext` grants superadmins a synthetic `admin` role for any gym, so they can access all domain routes.
- Frontend: `GymContext` exposes `isSuperadmin` from Clerk's `useUser()`.
- `infra/seed.ts` bootstraps the first superadmin from `SEED_USER_ID`.

### User Impersonation (#135, extended by #189)
Superadmins can impersonate any active gym user for support and debugging without a password change.

**How it works (separation of authentication and authorization):**
- The authenticated identity never changes. Only the *effective* identity used for authorization changes.
- The frontend stores an impersonation session in `sessionStorage` (survives refresh, cleared on tab close).
- `apiFetch()` appends `x-impersonate-as: <value>` to every request while impersonating. The value is `member:<id>` when impersonating a member (using `members.id`), or the Clerk user ID when impersonating a staff user.
- `tenantContext` detects this header and, after confirming the caller is a superadmin, resolves the effective identity. For `member:<id>` prefixed values it queries `members` directly (no `gym_memberships` join needed, so members without Clerk accounts are eligible). For Clerk user IDs it falls back to the existing `gym_memberships` lookup. Sets `effectiveType: 'member' | 'staff' | null` on the context.
- `TenantContext` carries `effectiveUserId` and `effectiveType`. For member impersonation `effectiveUserId` is the `members.id` as a string; for staff or normal usage it is the Clerk user ID. All `/me/*` handlers use the `resolveMemberId(gymId, ctx)` helper which routes to `WHERE members.id = ?` or `WHERE clerk_user_id = ?` depending on `effectiveType`.
- `recordAudit` encodes both identities in `actor_name` (e.g. `"Alice Johnson (impersonating John Smith)"`) so every business audit row remains traceable.

**API surface** (`api/src/api/impersonation.ts`, mounted at `/platform/impersonation`, no `tenantContext` middleware — uses `requireSuperadmin` only):
- `GET /platform/impersonation/targets?q=&gym_id=` — returns active staff (non-member roles in `gym_memberships`, name LIKE) + **all active members** (`members.deleted_at IS NULL`, no Clerk requirement); excludes the caller and other superadmins. Returns `[{ id, name, type, role, gymId }]` where member `id` is `"member:<members.id>"` and staff `id` is the Clerk user ID.
- `POST /platform/impersonation/stop` — accepts `{ impersonated_user_id, impersonated_user_name?, impersonated_role?, duration_seconds? }`, returns 204. Must be declared before `/:targetId` in the router to avoid being swallowed by the dynamic segment.
- `POST /platform/impersonation/:targetId` — body `{ targetType: 'member' | 'staff' }`. For members: queries `members` by `id`; returns `{ id: 'member:<N>', name, role: 'member', gym_id, gymIds }`. For staff: Clerk lookup + gym_memberships check (not another superadmin, not yourself); returns `{ id: <clerkUserId>, name, role, gym_id, gymIds }`. `gymIds` restricts the gym selector in the frontend.

**Frontend — Admin app** (`apps/admin/src/`):
- `ImpersonationContext.tsx` — `ImpersonationSession` includes `gymIds: string[]`; `ImpersonationProvider` wraps the app and rehydrates from `sessionStorage` on mount.
- `TopHeader.tsx` — renders an "Impersonate" button (superadmin only, not while impersonating) and an `ImpersonationDialog`; replaces `UserButton` with a locked avatar div during impersonation.
- `ImpersonationDialog.tsx` — modal with debounced search calling `GET /targets`, results list with member/staff type badges, confirms via `POST /:targetId` with `{ targetType }` body.
- `GymContext.tsx` — while impersonating, filters visible gyms to `session.gymIds` and overrides `role` with `effectiveRole`.

**Frontend — Member app** (`apps/member/src/`):
- `ImpersonationContext.tsx` — same session shape as admin app.
- `AdminBar.tsx` — superadmin-only top strip rendered above `CenterSwitcher` in the layout; shows "Impersonate" button (via `MemberImpersonationDialog`) when not impersonating, or `ImpersonationBanner` when impersonating.
- `MemberImpersonationDialog.tsx` — uses raw `fetch` (not `apiFetch`) since `gymId` may not yet be resolved in `AppContext` when impersonation starts; calls `GET /targets` and `POST /:targetId` with `{ targetType }` body.
- `ImpersonationBanner.tsx` — amber top bar with stop button; calls `POST /platform/impersonation/stop`.
- `AppContext.tsx` — exposes `isSuperadmin` (via `useUser()` + Clerk `publicMetadata`); reads sessionStorage on mount and adds `x-impersonate-as` to the initial `GET /me/gym` call.
- `apiClient.ts` — appends `x-impersonate-as` header to all API calls when an impersonation session is stored.

**Restrictions**: cannot impersonate disabled users, other superadmins, or yourself. No new DB tables.

---

## Multi-tenancy Pattern

Every domain table has `gym_id CHAR(36) REFERENCES gyms`. Every query filters by it:

```sql
SELECT * FROM members WHERE gym_id = ? AND deleted_at IS NULL
```

The frontend sends `x-gym-id` on every request via `apiFetch()`, which reads it from `GymContext.activeGymId`. Global lookup tables (`benefit_types`, `charge_types`, `action_types`, `nutrition_library_items`, `result_types`) are the deliberate exception — they have no `gym_id` and are seeded in their migrations.

---

## Database Conventions

- **Migrations**: Knex JS files in `infra/migrations/`. Numbered sequentially (`001_` … `071_`). Run with `npm run db:migrate`. ⚠️ MySQL DDL is **non-transactional** — a failed migration leaves partial state, so keep migrations small and re-runnable (guard `ALTER`s with `hasColumn`/information_schema checks — see `030_gym_theme.js`).
- **Primary keys**: auto-increment `INT UNSIGNED` for domain tables, `CHAR(36)` UUID for `gyms` (tenant root, `DEFAULT (UUID())`).
- **Timestamps**: `DATETIME`, always UTC (the mysql2 pool uses `timezone: 'Z'`; use `UTC_TIMESTAMP()` in SQL, never `NOW()`).
- **Indexed text columns**: `VARCHAR(n)`, not `TEXT` (MySQL cannot index TEXT without a prefix length).
- **Soft deletes**: Add `deleted_at DATETIME` and filter `WHERE deleted_at IS NULL`. Used for members, workout templates (which also set `status='deleted'`), and exercises (`status='deleted'` + `deleted_at`; the `(gym_id, name)` unique index was dropped so a deleted name can be reused — uniqueness among non-deleted rows is enforced in the router). Consider for other user-facing entities.
- **Cascade**: FK `ON DELETE CASCADE` when the child has no meaning without the parent. Use `ON DELETE SET NULL` when the reference is optional.
- **Duplicates**: unique-key violations surface as `err.code === 'ER_DUP_ENTRY'` (errno 1062) → return 409.
- **Statuses**: `VARCHAR` + a **named** CHECK constraint (so the allowed set can evolve without an `ALTER TYPE` dance).
- **No partial/filtered indexes** in MySQL: for "unique among non-deleted/active rows" use a generated column + unique index.
- **Inserts**: no `RETURNING` in MySQL — insert, then `SELECT` by `insertId` (returned by the `db.query` helper). Upserts use `INSERT ... AS new ON DUPLICATE KEY UPDATE col = new.col`; "insert if absent" uses `INSERT IGNORE`.
- **Transactions**: multi-statement writes use `db.transaction(async (tx) => { … })` — never `BEGIN`/`COMMIT` through `db.query` (pooled connections).

### `gym_memberships` (the "users in a gym" table)

Beyond `user_id`, `gym_id`, `role`, this table now carries invitation state (migrations 031–034):
- `status` — `active | invited` (named CHECK).
- `email` — set for invited rows before a Clerk user exists; cleared to `NULL` on link.
- `name` — display name (editable for invited rows).
- `invitation_id` — the Clerk invitation id, used to revoke on removal.

Invited rows use a placeholder `user_id` of the form `invited_<timestamp>` until the invitee signs in and `/gym-users/link` materializes the real Clerk `user_id`.

### `members` (portal-invite tracking, migration 051)

`members.invitation_id` (nullable, migration 051) mirrors `gym_memberships.invitation_id` — the pending Clerk invitation id, used to revoke on removal or explicit un-invite. Unlike `gym_memberships`, there's no `status` column: a member row is always "real" (it's the billing/plan record) independent of portal access, so portal state is derived as `clerk_user_id IS NULL AND invitation_id IS NOT NULL` (invited) vs `clerk_user_id` set (linked) vs neither (never invited). See "Member invite + auto-link flow" below.

### `user_memberships` — billing columns (migration 111)

Two nullable columns added for recurring MIT billing:
- `next_billing_date DATE NULL` — set by the payment webhook on the first successful charge (DATE_ADD(starts_at, INTERVAL bp.recurring_billing_interval bp.recurring_billing_unit)); advanced by the billing run after each subsequent charge.
- `last_billed_at DATETIME NULL` — stamped by the billing run on success.

### `billing_run_log` (migration 111)

System-wide singleton (single row, id=1, CHECK id=1). Not a per-tenant table — intentional exception to the `gym_id` convention. Tracks `last_run_at DATETIME NULL` for the 23-hour rate limit on `POST /billing/run`.

`billing_events.event_type` CHECK extended with `recurring_payment` and `failed_billing`. `payment_requests.source` CHECK extended with `billing_run`.

---

## Backend Route Registration (`index.ts`)

```ts
// Public — no auth, no tenant context (identified by gym slug)
app.use('/public', publicRouter);

// Auth but no tenant context (gymId not known yet)
app.use('/gyms',                  requireAuth(), gymsRouter);
app.use('/platform',              requireAuth(), platformRouter);            // superadmin only
app.use('/platform/superadmins',  requireAuth(), superadminsRouter);         // superadmin only

// Link routes must run BEFORE tenantContext (no membership row exists yet on first link)
app.use('/me/link',        requireAuth(), meLinkRouter);
app.use('/gym-users/link', requireAuth(), gymUsersLinkRouter);

// Member self-service — auth + tenant context (member role)
app.use('/me',             requireAuth(), tenantContext, meRouter);

// Team + all domain routes — auth + tenant context
app.use('/gym-users',              requireAuth(), tenantContext, gymUsersRouter);
app.use('/members',                requireAuth(), tenantContext, membersRouter);
app.use('/bookings',               requireAuth(), tenantContext, bookingsRouter);
app.use('/user-memberships',       requireAuth(), tenantContext, userMembershipsRouter);
app.use('/user-memberships/:id/promotions', requireAuth(), tenantContext, membershipPromotionsRouter);
app.use('/muscles',                requireAuth(), tenantContext, musclesRouter);
app.use('/result-types',           requireAuth(), tenantContext, resultTypesRouter);
app.use('/exercises',              requireAuth(), tenantContext, exercisesRouter);
app.use('/workouts',               requireAuth(), tenantContext, workoutsRouter);
app.use('/training-plan-templates',requireAuth(), tenantContext, trainingPlanTemplatesRouter);
app.use('/training-plans',         requireAuth(), tenantContext, gymTrainingPlansRouter);        // #67
app.use('/members/:memberId/training-plans',        requireAuth(), tenantContext, trainingPlansRouter);
app.use('/members/:memberId/member-training-plans', requireAuth(), tenantContext, memberTrainingPlansRouter);
app.use('/members/:memberId/workout-logs',   requireAuth(), tenantContext, memberWorkoutLogsRouter);
app.use('/audit-logs',             requireAuth(), tenantContext, auditLogsRouter);
app.use('/membership-plans',       requireAuth(), tenantContext, membershipPlansRouter);
app.use('/benefit-types',          requireAuth(), tenantContext, benefitTypesRouter);
app.use('/charge-types',           requireAuth(), tenantContext, chargeTypesRouter);
app.use('/sellable-items',         requireAuth(), tenantContext, sellableItemsRouter);
app.use('/taxes',                  requireAuth(), tenantContext, taxesRouter);
app.use('/billing-events',         requireAuth(), tenantContext, billingEventsRouter);
app.use('/spaces',                 requireAuth(), tenantContext, spacesRouter);
app.use('/trainers',               requireAuth(), tenantContext, trainersRouter);
app.use('/activity-types',         requireAuth(), tenantContext, activityTypesRouter);
app.use('/class-sessions',         requireAuth(), tenantContext, classSessionsRouter);
app.use('/class-packages',         requireAuth(), tenantContext, classPackagesRouter);
app.use('/action-types',           requireAuth(), tenantContext, actionTypesRouter);
app.use('/promotions',             requireAuth(), tenantContext, promotionsRouter);
app.use('/promotions/:id',         requireAuth(), tenantContext, promotionDetailsRouter);
app.use('/members/:memberId/class-packages', requireAuth(), tenantContext, userClassPackagesRouter);
app.use('/nutrition-plan-templates', requireAuth(), tenantContext, nutritionPlanTemplatesRouter);
app.use('/nutrition-library', requireAuth(), tenantContext, requireModuleAccess('NUTRITION'), nutritionLibraryRouter);
app.use('/member-nutrition-plans', requireAuth(), tenantContext, requireModuleAccess('NUTRITION'), memberNutritionPlansRouter);
app.use('/platform/nutrition-library', requireAuth(), platformNutritionLibraryRouter);
app.use('/platform/nutrition-plan-templates', requireAuth(), platformNutritionPlanTemplatesRouter);

// package-credits and plan-allowances register booking-lifecycle hooks as side-effect imports
// (package-credits imported BEFORE plan-allowances so its hook queues first).
```

Legacy `/fares` and `/subscriptions` routers are fully removed (migrations 004, 007, 009).

### Member invite + auto-link flow (`members` + `me`)

Unlike Team, a `members` row is the record of truth (name, contact, plan, billing) whether or not the member ever gets portal access — invite is a separate, optional action layered on top, not part of creating the member. Portal state is derived from two columns, never a `status` enum: `clerk_user_id` (set once linked) and `invitation_id` (the pending Clerk invitation, if any).

1. Staff calls `POST /members/:id/invite` (also `admin`,`staff`) → Clerk sends an invitation email with redirect to the member app (`CORDEL_FITNESS_MEMBERS_URL`), and the returned invitation id is stored in `members.invitation_id`. 409s if the member already has a linked `clerk_user_id`.
2. `POST /members/:id/reinvite` resends it (only valid while `clerk_user_id IS NULL AND invitation_id IS NOT NULL`) and **overwrites** `invitation_id` with the new one — this matters because the old id is no longer revocable once superseded (see the Team reinvite note below for the bug this avoids).
3. `POST /members/:id/revoke-invite` cancels a pending invitation without touching the member record — for when staff invited someone by mistake or changed their mind, but the member stays on the roster.
4. Member signs in via Clerk in `apps/member`.
5. On first sign-in the app calls `POST /me/link` (no `gym_memberships` row yet) — backend matches by email + gym_id (requiring `clerk_user_id IS NULL AND deleted_at IS NULL`), sets `members.clerk_user_id`, clears `invitation_id`, and inserts `gym_memberships(role='member')`.
6. Subsequent requests use `/me/*` routes with `tenantContext` resolving the member role.

**Removing a member with a pending, not-yet-accepted invitation revokes it.** `DELETE /members/:id` (soft-delete) checks `clerk_user_id IS NULL AND invitation_id IS NOT NULL` before setting `deleted_at`, and best-effort calls `clerkClient.invitations.revokeInvitation()` first (a revoke failure doesn't block the soft-delete) — same race this closes as the Team flow: `/me/link` already refuses to link into a soft-deleted (`deleted_at IS NOT NULL`) row, so without the revoke the only leftover risk was an orphaned, still-valid Clerk invitation email and a wasted invitation slot, not an actual access breach. Revoking it is cleanup, not a security fix, in this case — the DB-level `deleted_at` guard was already sufficient. This still depends on the Clerk instance being in **Restricted mode** (see "Auth (Clerk)" above) to stop a fresh, uninvited self-registration with the same email.

### Team invite + auto-link flow (`gym-users`)

Admins manage coaches/staff/admins from the **Team** page. `POST /gym-users`:
- If Clerk already knows the email → insert/update a `gym_memberships` row directly.
- If not → create a Clerk invitation carrying `publicMetadata.gym_invite = { gym_id, role }`, and insert an `invited` placeholder row.
- On the invitee's first admin-app sign-in, `POST /gym-users/link` reads that metadata, materializes/activates the row, and clears the metadata.

Guards: self-edit blocked (can't change your own role or remove yourself), and last-admin protection (can't demote/remove the sole remaining admin). All team mutations call `recordAudit`. `POST /gym-users/:id/reinvite` creates a new Clerk invitation and **overwrites** the stored `invitation_id` with it — the previous id becomes stale/unrevocable the moment a new invitation is issued, so leaving it in place would make a later removal revoke the wrong (already-superseded) invitation while the actually-live one stayed active.

**Removing an invited (not-yet-accepted) user is a revoke, not a delete.** This closes a race: an admin invites someone, then removes them before they click the email link — without revocation, the `gym_memberships` row would be gone from the app but the Clerk invitation would still be live, so accepting it later would silently recreate team access. `DELETE /gym-users/:id` handles both cases through the same endpoint: if `status === 'invited'`, it calls `clerkClient.invitations.revokeInvitation(invitation_id)` before deleting the row (best-effort — a revoke failure doesn't block the row deletion); if the row belongs to an active Clerk user, it deletes the `gym_memberships` row and additionally deletes the Clerk user outright if this was their last gym membership anywhere. The admin UI (`apps/admin/.../team/page.tsx`) reflects this at the label level only — same delete flow, but the action button/confirm dialog read "Revoke" for `status === 'invited'` rows and "Remove" otherwise, so admins understand which side effect they're triggering.

Revoking the invitation closes the race for the *link itself* (Clerk shows "The invitation was revoked" if they click it), but does **not** by itself stop that email from just self-registering fresh at `/sign-up` — that's a separate, instance-wide Clerk setting, not something this endpoint can control. See "Required Clerk instance setting: Restricted mode" above; with it enabled, sign-up requires a currently-valid invitation, so a revoked one is rejected outright instead of letting a brand-new, gym-less account through.

---

## Audit Logging (`infra/audit.ts` + `audit_logs`)

`recordAudit(req, { action, entityType, entityId?, entityName?, previous?, next? })` is a **fire-and-forget** writer: it never fails the calling request (a rejected INSERT just logs to `console.error`). Each row is a self-contained historical snapshot:

- **`actor_name`** — display name captured from the Clerk user object already fetched in `tenantContext` (zero extra queries). Populated on every write; survives later Clerk user renames.
- **`entity_name`** — resolved by `infra/audit-registry.ts` at write time. Named entities (those with a `name` column) use a registry lookup; M-N/link entities (e.g. `user_membership`) get a composed label from their FK parents. Callers may pass `entityName` directly to skip the lookup. The UI shows "Unknown" (translated) when the field is null.
- **FK enrichment** — `previous_values`/`new_values` are enriched before storage: `foo_id: value` becomes `foo: { id, name }` using the FK map in `audit-registry.ts`.

The registry (`AUDIT_ENTITY_REGISTRY`) and action list (`AUDIT_ACTIONS`) are served by `GET /audit-logs/meta` for frontend dropdown population. High-value mutations call `recordAudit` after the business write; `class-types.ts` and `promotions.ts` were added in #69.

Two read views share one endpoint and one React component (`AuditLogView`): **System → Audit log** (`/audit`, admin+) is scoped to the active gym; **Cordel → Audit log** (`/cordel/audit`, superadmin) sends `?scope=all` to see every gym's events with a Gym column joined in (#66). Filters: `entity_type` (dropdown), `entity_name` (LIKE on stored snapshot), `actor` (name LIKE or Clerk ID exact), `action` (dropdown), `source` (dropdown), `from`/`to` date range.

---

## Frontend Patterns

Both frontends follow the same proxy + context pattern. The admin app uses `GymContext`; the member app uses `AppContext`.

### API calls
All requests go through `apiFetch()` (from `useApiClient()`), which:
1. Gets a fresh Clerk token.
2. Attaches `Authorization: Bearer <token>`.
3. Attaches `x-gym-id: <activeGymId>`.
4. Hits `/api/proxy/<path>` → Next.js proxy route → backend. The proxy MUST stay on the Node runtime (no `runtime = 'edge'`). The API has no CORS — it is reachable only through these proxies. The proxy target is `CORDEL_FITNESS_API_URL` (deployed: `https://api.vdicube.com`; local dev: `http://localhost:3000`).

### Backoffice: GymContext
Available via `useGym()`. Key fields:
```ts
activeGymId: string | null
activeGym: { id, name, slug, role, theme_key? } | null
isSuperadmin: boolean
loading: boolean
```

### Member app: AppContext
Available via `useApp()`. Key fields:
```ts
gymId: string | null      // from URL param or localStorage
member: MemberProfile | null
isLinked: boolean
loading: boolean
```

### Admin navigation (grouped sidebar)
The sidebar is **config-driven** from `config/navigationGroups.ts`. Groups are collapsible; each group and item can declare a `requiredRole` (`staff | admin | superadmin`, hierarchical) and `filterNavGroups()` hides anything above the user's role. Expanded state persists in `sessionStorage`; the group containing the active route auto-expands. Current groups:

| Group | requiredRole | Items |
|-------|--------------|-------|
| Membership | — | Dashboard, Members (→ Deleted) |
| Organization | `admin` | Dashboard, Team, Centers, Rooms, Resources, Trainers, Specialities, Class types, Class packages, Events |
| Training | — | Dashboard, Exercises, Workout Templates, Training Plan Templates, ‹divider›, Training Plans (#67) |
| Nutrition | — | Dashboard (placeholder) |
| Payments | — | Transactions |
| Financials | `admin` | Dashboard, Plans, Promotions, Payment Providers (placeholder) |
| System | `admin` | Audit log (gym-scoped) |
| Cordel | `superadmin` | Gyms, Users, Audit log (platform-wide, `/cordel/audit`), Themes |

The per-group "Dashboard" pages (Organization, Training, Nutrition, Financials, plus the singular `/membership`) are **placeholder shells** ("coming soon") today. Some functional pages (e.g. `/memberships` — the user-membership manager with ledger + promotion-apply modals — and `/schedule`) exist and are reachable but are not yet linked from a nav group.

### AppShell (admin)
Wraps all admin pages. Hides sidebar + header for sign-in/sign-up and the unauthenticated home page.

### Theming (`ThemeProvider` + per-gym `theme_id`)

**Two tiers of themes (migration 065):**
- **Base Themes** — `gym_id IS NULL`. Platform-owned, managed by superadmins via **Cordel → Base Themes**. Never duplicated into customer data. Exactly one Base Theme carries `is_system_default = 1` (migration 072) — the factory default assigned when a new organization is created.
- **Customer Themes** — `gym_id = <gymId>`. Gym-owned, created by cloning any Base or Customer Theme. Editable and soft-deletable by gym admins via **System → Themes**.

Each gym references an optional **Theme** entity (`gyms.theme_id`, migration 057, FK on `themes.id`). Themes carry a versioned `tokens` JSON column (`v: 3` as of migration 099) covering typography (5 levels × `fontFamily` + `color`) and 27 named colors grouped as: **Application** (`pageBackground`, `textColor`, `cardBackground`, `cardBorder`), **Header** (`headerBackground`, `headerText`, `headerSeparatorColor`, `headerSeparatorHeight`), **Sidebar** (`sidebarBackground`, `sidebarText`, `sidebarSelectedItemBackground`, `sidebarSelectedItemText`, `sidebarHoverBackground`), **Navigation** (`dropdownBackground`, `dropdownText`, `dropdownHoverBackground`), **Buttons** (`primaryButton`, `primaryButtonText`, `secondaryButton`, `secondaryButtonText`), **Status** (`statusSuccess`, `statusWarning`, `statusError`, `statusInfo`), **Links** (`linkColor`, `linkHoverColor`). Additional design tokens live in the `advanced` JSONB map (layout, shape, shadows, typography, animations). Each center may optionally override the gym's default theme via `centers.theme_id` (migration 065).

**Theme ownership and lifecycle:** `gym_id IS NULL` = system/base theme (Cordel-owned); `gym_id = <id>` = customer theme. Status lifecycle: `draft → active → inactive → deleted` (migration 079 widens the CHECK constraint). Deleting or setting a theme to `draft`/`inactive` is blocked (409) when it is assigned as the gym's default (`gyms.theme_id`) or to any center (`centers.theme_id`). Only `active` themes can be assigned as gym default or to centers.

`ThemeProvider` in both the admin app (`context/GymContext` → `activeGym.theme.tokens`) and the member app (`context/AppContext` → resolved via `GET /me/gym`) writes `--gd-*` CSS variables to `<html>` on gym switch; legacy `--brand`/`--chrome`/`--accent` aliases are preserved. Logos are `MEDIUMBLOB` (≤ 512 KB; allow-list: PNG, SVG, JPEG, WEBP), served public at `GET /themes/:id/logo` (`Cache-Control: immutable`). The member app resolves its gym and theme in one call via `GET /me/gym` (no `x-gym-id` header required).

**Theme resolution order (per center):**
1. `centers.theme_id` (explicit center assignment)
2. `gyms.theme_id` (gym default)
3. First theme alphabetically

**API surface:**
- `GET|POST|PUT|DELETE /platform/themes` — superadmin Base Themes CRUD only (`gym_id IS NULL`). `PUT` accepts `status` in `['draft','active','inactive']`; setting `draft`/`inactive` is blocked (409) when assigned as gym default or to centers. `DELETE` is also blocked (409) for the same reason.
- `PUT /platform/themes/:id/set-system-default` — atomically marks one Base Theme as `is_system_default = 1` and clears all others (superadmin only).
- `POST /platform/themes/clone/:id` — clone a Base Theme into a new Base Theme (superadmin only).
- `GET /system/themes` — gym admin: lists Base Themes + Customer Themes for the active gym.
- `POST /system/themes/clone/:id` — clone any accessible theme into a new Customer Theme.
- `PUT|DELETE /system/themes/:id` — update/soft-delete a Customer Theme (same protection rules as above).
- `GET /system/themes/:id/assignments` — returns `{ is_gym_default, centers: [{id, name, is_inherited}] }`.
- `PUT /system/themes/:id/set-default` — sets `gyms.theme_id`; rejects non-active themes (400).
- `GET /system/themes/:id/unassigned-centers` — centers not currently using this theme (for the assign picker).
- `POST /system/themes/:id/assign-centers` — body `{ center_ids }`; rejects non-active themes (400).
- `DELETE /system/themes/:id/centers/:centerId` — restores inheritance: sets `centers.theme_id = NULL`.

### Middleware (both apps)
Both apps use `clerkMiddleware` + `next-intl` middleware together. Public routes bypass `auth.protect()`. Both require `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (baked at build time) and `CLERK_SECRET_KEY` (runtime).

### i18n
All strings live in each app's `locales/base/{en,es,ca}.json`, namespaced by feature. Use `useTranslations()` in every page/component. The admin app has a `LanguagePicker`.

---

## Domain Modules

### Admin (`apps/admin`)

| Module | Backend router(s) | Frontend page | Notes |
|--------|-------------------|---------------|-------|
| Members | `members.ts` | `[locale]/members/` (+ `/deleted`) | Canonical staff-level CRUD reference. Soft-delete + restore; `clerk_user_id`; `/:id/invite`, `/:id/reinvite`, `/:id/revoke-invite` for member-portal access. Removing a member with a pending invite revokes it in Clerk. |
| Team | `gym-users.ts` | `[locale]/team/`, `[locale]/link-team/` | Admin-only. Invite/grant/change-role/remove admin/coach/staff. Clerk invitation flow, self-edit & last-admin guards, audited. Removing a pending invite revokes it in Clerk (UI labels this "Revoke"). |
| Spaces | `spaces.ts` | `[locale]/spaces/` | Admin-only CRUD. Inline creation row (no pre-API-call); clicking row expands read-only accordion (General/Availability/Activity Types/Notes sections all auto-shown); Edit from context menu opens inline edit form; StatusBadge in row; Details modal with full audit info. Duplicate, soft-delete, activity-type assignments, availability hours, notes. `space_activity_types` join table. SELECT LEFT JOINs `gym_memberships` ×3 for `created_by_name`, `modified_by_name`, `deleted_by_name`. |
| Trainers | `trainers.ts` | `[locale]/trainers/` | Lists coach-role members with availability management. Speciality concept removed in #219. |
| Activity types | `activity-types.ts`, `activity-type-schedule-rules.ts` | `[locale]/activity-types/` | Admin-only CRUD (#70, redesigned #269). (#324) `is_shareable TINYINT DEFAULT 0` added — when true, this activity type's sessions can participate in shared-training bookings. `activity_types` table extended in #190 with `default_space_id`, `default_trainer_membership_id`, `color`; extended in #269 with `default_center_id FK→centers`, full audit columns (`created_by_membership_id`, `modified_at`, `modified_by_membership_id`, `deleted_at`, `deleted_by_membership_id`), and soft-delete. `gyms.timezone VARCHAR(64) DEFAULT 'Europe/Madrid'` added. New `activity_type_schedule_rules` table: one row per recurrence unit (type one_off/weekly/monthly; weekday 0=Sun…6=Sat; ordinal for monthly; start_time/end_time in HH:MM). Sub-router `/activity-types/:id/schedule-rules` (GET/POST/PUT/DELETE). `domain/scheduleEngine.ts`: Luxon-based occurrence generator + `materializeScheduleRule` (bulk-inserts calendar_events in chunks of 200) + `cancelFutureOccurrences` (preserves past, cancels future). `calendar_events.schedule_rule_id FK→activity_type_schedule_rules ON DELETE SET NULL`. `POST /:id/duplicate` deep-copies rules and materializes calendar events. `POST /:id/restore` restores soft-deleted types. `recycle-bin` extended with `activity_type` branch. Admin page: expandable-row UX — inline `+ Create Activity Type` row (Name/Duration/Capacity), collapsed header (Name/Description/Duration·Capacity/Default Center/Status/ContextMenu), expanded General + Schedule (inline rule CRUD) + Metadata sections; center→space linked dropdowns. |
| Calendar events | `calendar-events.ts`, `calendar-event-series.ts` | `[locale]/calendar/` | TRAINING module (#190 #191). Standalone and recurring scheduled events. **Recurrence** (#191): `calendar_event_series` table stores the pattern template; `calendar_events` gains `series_id` FK (ON DELETE SET NULL) and `series_occurrence_date DATE` (canonical scheduled date, survives drag-and-drop). Pure-TS `domain/recurrenceEngine.ts` generates occurrence dates (daily/weekdays/weekends/weekly/monthly/yearly, configurable interval, end by date/count/never, 13-month rolling cap for never-ending series). "Exploded" storage: each occurrence is an independent `calendar_events` row — bookings and attendance attach to individual events. Scope-based mutations via `?scope=this|this_and_following|entire_series` on PUT/DELETE: `this` edits/cancels one; `this_and_following` splits the series (truncates original end_date, creates new series from cutDate); `entire_series` updates template + regenerates future occurrences. Recurring cancellation uses `status='cancelled'` (visible on calendar); standalone delete uses soft-delete. `GET /calendar-event-series` and `DELETE /calendar-event-series/:id` (cancels future + soft-deletes series row). MySQL DATE columns returned as JS Date objects by mysql2 — `toDateStr()` normalizer in calendar-events.ts handles both types. Admin UI: ScopeDialog appears before editing/deleting a recurring event; RecurrenceEditor component in CalendarEventModal for create and whole-series edits. Full CRUD with space/trainer conflict detection (409). FullCalendar v6 day/week/month views, drag-and-drop and resize (always `scope=this`). Soft-delete, full audit fields, status CHECK. **#326**: Calendar page now also fetches `class_sessions` (tagged `_type:'session'` in extendedProps, prefixed `cs-{id}`) and renders them alongside calendar events (prefixed `ce-{id}`). Clicking a class session opens `ClassSessionDetailPanel` (instance management panel) instead of `EventDetailsPanel`; sessions are non-draggable/non-resizable (time changes go through the panel's Change Time flow). `ClassSessionDetailPanel` provides: enrolled member list with Remove (→ `DELETE /bookings/:id`, atomic auto-promote), Add Member (member search → capacity check → `POST /bookings` with optional `force=true`), waiting list with Add to Waiting List (`POST /bookings` with `waitlist=true`), Change Time (`PUT /class-sessions/:id`), Cancel Event (`POST /class-sessions/:id/cancel`). `MemberSearchInput` debounced combo component uses `GET /members?q=`. `GET /class-sessions` accepts `activity_type_id`, `space_id`, `trainer_membership_id` filter params. `GET /members?q=` LIKE search on name/email, max 20 results. `POST /bookings` `waitlist=true` flag inserts as waitlisted regardless of capacity. Shareable training deferred (no backend domain). |
| Class sessions | `class-sessions.ts` | `[locale]/schedule/` | Scheduled instances of an activity type (space, trainer, capacity). Create/update/cancel by admin/coach/staff. (#324) `allows_shared_booking TINYINT DEFAULT 0` added — when true, a second group may book via a shared-training request. `PUT /:id` accepts `allows_shared_booking`. Admin schedule page gains "Toggle Sharing" button (fires PUT) and "Shared" button → `SharedTrainingPanel` drawer. `effective_trainer_membership_id` records who actually delivered the session (set via `PUT /:id/effective-trainer`). `POST /:id/bulk-present` marks all pending confirmed bookings as present. `POST /:id/complete` completes the session — hard-blocked unless all confirmed bookings have a non-pending `attendance_status` and at least one trainer is set (responds 400 with `{pending_count, missing_trainer}`). GET SELECT includes `booked_count`, `attendance_present`, `attendance_absent`, `attendance_pending` subquery counts. |
| Bookings | `bookings.ts` | (inside Schedule) | Waitlist, capacity, attendance. `attendance_status VARCHAR(20)` ('pending'|'present'|'absent') tracks attendance separately from the booking lifecycle `status` ('booked'|'waitlisted'|'cancelled'). `POST /:id/attendance` sets attendance_status (staff-level: admin/front_desk/trainer roles). `POST /bookings` accepts `force=true` to add a walk-in over capacity (always inserts as 'booked', returns `over_capacity: true`). Credit consume/refund hooks via `package-credits` and `plan-allowances`. |
| Shared training requests | `shared-training-requests.ts` | `[locale]/schedule/` (SharedTrainingPanel) | (#324) TRAINING module + `calendar.member_calendar` flag. `shared_training_requests` table: id, gym_id (FK), class_session_id (FK), requesting_member_id (FK members), activity_type_id (FK), status CHECK (pending/approved/rejected/cancelled), reviewed_by_membership_id (FK gym_memberships ON DELETE SET NULL), reviewed_at, created_at. UNIQUE (gym_id, class_session_id, requesting_member_id). `GET /?status&class_session_id` — trainers see only their sessions' requests. `POST /:id/approve` — transactional: locks request + session rows (FOR UPDATE), re-checks is_shareable + allows_shared_booking + `booked_count - effective_capacity < 1` (V1 max 2 groups), INSERTs booking directly (bypasses access hooks — explicit override), fires `shared_training_approved` notification. `POST /:id/reject` — sets status='rejected', fires `shared_training_rejected` notification. Both write-actions use `requireModuleWrite('TRAINING')`. |
| Member Notifications | — (member-facing via `/me/*`) | `[locale]/notifications/` | (#194) `member_notifications` table: gym_id, member_id, type, entity_type, entity_id, payload (JSON), read_at, created_at. 7 active types: booking_confirmed, waitlist_joined, promoted_from_waitlist, booking_reminder_24h, booking_reminder_1h, shared_training_approved, shared_training_rejected. Written fire-and-forget by `sendNotification`/`sendBulkNotification` in `infra/notifications.ts` — never blocks the response. Session cancellation bulk-notifies all booked members. `cancelBooking` returns `promotedMemberId` so the caller can notify promoted members. |
| Plans | `membership-plans.ts`, `plan-allowances.ts` | `[locale]/plans/` | Admin-only CRUD (#70). `lifecycle_status` (draft/active/paused/inactive) + `enrollment_status` (public/staff_only/closed) + soft delete. Nested: prices (validity windows), `billing_policies` (4 billing/service cycle pairs + auto_renew), `plan_allowances` (unlimited or session_count per activity type with recurrence), `membership_plan_centers` (optional center restriction), `plan_charge_benefits` (per-plan benefit per gym charge: FK `gym_charge_id→gym_charges`, `action VARCHAR(30)` — migration 091 replaced old `charge_type_id→charge_types` FK; UNIQUE on `(membership_plan_id, gym_charge_id)`). (#213) UX redesign: `+ Add Plan` creates an inline-editable row; context menu → Edit expands the row in edit mode with explicit Save/Cancel; Duplicate opens a new editable row. Expanded area shows Charge Benefits section (all gym charges with per-row action selector, replace-all PUT) and Period Benefits section (all gym activity_types with enabled checkbox + quantity + frequency). Row layout: Name, Description, Created By, Created At, Status badge, Enrollment badge, Actions (`⋮`). `GET /` and `GET /:id` include `charge_benefits` array in enriched response. New endpoints: `GET /:id/charge-benefits`, `PUT /:id/charge-benefits` (replace-all). Duplicate endpoint uses `db.transaction()`. |
| Benefit types | `benefit-types.ts` | (inside Plans) | Global lookup (no `gym_id`), seeded. |
| User memberships | `user-memberships.ts`, `membership-promotions.ts` | `[locale]/memberships/` | Status changes write a `status_changed` billing event in the same tx. Apply promotions to a membership. `GET /user-memberships` accepts optional `?status` and `?member_id` query filters. |
| Billing ledger | `billing-events.ts` | Ledger drawer in `[locale]/memberships/` | Append-only (GET + POST). `status_changed` rows are system-emitted. |
| Payments | `payments.ts` | `[locale]/payments/` (Transactions) | PAYMENTS module (#129). Operational view of `billing_events` excluding `status_changed`. Exposes `POST /payments/apply-promotion` which delegates to the exported `applyPromotionToMembership` from `membership-promotions.ts`. |
| Payment Providers | — | `[locale]/financials/payment-providers/` | FINANCIALS module (#159). Server component (no API call) reading `PAYMENT_PROVIDER`, `PAYMENT_ENV`, `MONEI_API_KEY`, `MONEI_WEBHOOK_SECRET`, `CORDEL_FITNESS_API_URL` from admin's process.env. Shows active provider, key/secret presence (masked), environment badge, and the webhook URL to register in the provider dashboard. `/payments/payment-providers` redirects here. |
| Charge types | `charge-types.ts` | (inside ledger's Record-payment modal) | Global lookup (no `gym_id`), seeded. Extended in migration 088 with `name VARCHAR(100)` and `is_gym_charge TINYINT(1)` flag; 4 new codes added (`locker_rental`, `parking_fee`, `access_key`, `premium_fitness_app`). |
| Sellable Items | `sellable-items.ts` | `[locale]/financials/sellable-items/` (redirects from `/gym-charges` and `/class-packages`) | #271. Unified model for all sellable items — consolidates the 6 system gym charges and migrated class packages. `gym_charges` table extended (migrations 102–103) with: `name VARCHAR(255)`, `type ENUM(fee/service/sessions/merchandise/other)`, `units INT UNSIGNED`, `status ENUM(active/inactive)`, `is_system TINYINT(1)`, `deleted_at/deleted_by_membership_id/deleted_by_name` (soft-delete), `package_information TEXT`, `validity_days INT UNSIGNED`; `billing_frequency` CHECK extended with `'per_session'`. System items (`is_system=1`): auto-created at gym init, no delete, limited edits (description/amount/frequency/notes/status). Custom items (`is_system=0`): full CRUD with soft-delete. `GET /` filters: `?type`, `?status`, `?q` (name+description search). `POST /`: create custom item (requireRole admin). `PUT /:id`: system/custom split — system items: description/amount/billing_frequency/notes/status only; custom: all fields including name/type/units/package_information/validity_days. `POST /:id/activate` + `POST /:id/deactivate`: set status + keep legacy `availability` in sync. `DELETE /:id`: 403 on is_system=1, soft-delete otherwise. All endpoints fire audit via `recordAudit()`. `membership-plans.ts` and `promotion-details.ts` charge-benefit queries changed: LEFT JOIN charge_types, `COALESCE(gc.name, ct.name)` for name, filter by `status='active' AND deleted_at IS NULL`. Class packages migrated as `type='sessions'` custom items in migration 103; `class_packages` table kept (FK constraint). Admin UI: inline creation row, inline edit, type/status filters, name search, system/custom context menus (system: Details/Edit/Activate|Deactivate; custom: +Delete), delete confirm dialog with Recycle Bin note. |
| Class packages | `class-packages.ts`, `user-class-packages.ts`, `package-credits.ts` | `[locale]/class-packages/` | Catalog + per-member packages + credit transactions; credits consumed/refunded on booking lifecycle. |
| Promotions | `promotions.ts`, `promotion-details.ts` | `[locale]/promotions/` | Admin-only. Plan targeting, charge benefits, period benefits, included benefits. Soft delete via `lifecycle_status='deleted'` + `deleted_at` + `deleted_by_membership_id` (migration 093). Billing lifecycle config (migration 102): `free_months` (initial free period before billing), `paid_months` (months at promotional price), `bonus_months` (bonus months after paid period) on the `promotions` table. `promotion_charge_benefits` uses `gym_charge_id FK→gym_charges` + `action VARCHAR(30)` (no_benefit/waive/percentage_discount/fixed_discount/fixed_price); replace-all `PUT /charge-benefits`. `promotion_period_benefits`: `charge_type_id FK→charge_types`, `quantity`, `frequency_interval`, `frequency_unit ('week'\|'month')`, `duration_months` (nullable, independent from promotion availability), `enabled`; replace-all `PUT /period-benefits`. `promotion_included_benefits` (migration 102): one-time Sellable Item grants — `charge_type_id FK→charge_types`, `quantity`; replace-all `PUT /included-benefits` validates `is_gym_charge=0`. Charge_type seeds (`is_gym_charge=0`): `nutrition_service`, `personal_training`, `duet_personal_training`, `group_class`. Admin page: expandable-row UX; edit form has Billing & Duration section (three inputs) + live example timeline table + Included Benefits + Period Benefits with Duration column + Charge Benefits with Fixed Price. |
| Exercises / Muscles / Result Types | `exercises.ts`, `result-types.ts` | `[locale]/exercises/` | Per-gym exercise catalog; admin/coach CRUD; `POST /exercises/import-defaults` seeds defaults. Soft delete (`status='deleted'` + `deleted_at`). Muscles are a static in-app catalog (`domain/muscles.ts`, slug keys on `exercise_muscles.muscle`, labels via admin i18n) — no muscles table or CRUD. `GET /exercises/:id/references` powers the dependency dialog (#62). **Result types (#154)**: `result_types` is a global catalog table (9 types: repetitions, weight, distance, duration, pace, speed, calories, rpe, rest_time) with no `gym_id`. `exercise_allowed_result_types` is a join table (exercise_id + result_type_id composite PK, no `gym_id`, FKs CASCADE from both sides). `GET /exercises` returns `allowed_result_types` as a JSON array; PUT/POST accept `allowed_result_type_ids`. `GET /result-types` returns the full catalog (auth + tenant context required, no role gate). |
| Workout templates | `workout-templates.ts` | `[locale]/workout-templates/` | Reusable, block-based workout blueprints (blocks + per-block exercises); admin/coach. Tree-grid page (#63): expandable rows lazy-load the full hierarchy (`GET /:id` aggregates blocks+exercises via JSON_ARRAYAGG), and dnd-kit drag-and-drop covers block reorder, exercise reorder, and block moves **between** templates (`PUT /:id/blocks/:blockId/move`, transactional reparent + position recompaction in both parents). List endpoint returns the paginated `{items,total,limit,offset}` shape when `limit`/`offset` are passed (name/created_by/status filters + sort) and the legacy plain array otherwise — the Training Plan editor's workout selector depends on the latter. `created_by_membership_id` (migration 053) feeds the Created By column/filter. Status `active/inactive/deleted` (#62): selectors only offer active templates (`?status=active`), delete is soft, and `GET /workout-templates/:id/references` powers the dependency dialog. Block field visibility is driven by block type via `blockFieldConfig.ts` — see Feature Patterns' config-driven form pattern. Exercise limits per block type (#71): `BLOCK_TYPE_MAX_EXERCISES` in `blockFieldConfig.ts` (Standard=1, Superset=2, Triset=3, rest=unlimited); enforced on the API (422 `MaximumExercisesExceeded`) and in the UI (button hidden, `(n/max)` badge). **Fully inline editing (#130)**: all fields auto-save on blur/change; no modals. **Result type at exercise level (#154)**: `result_type` removed from blocks; `workout_template_exercises` now has `result_type_id` (FK→`result_types`, SET NULL on delete), `target_value`, `min_value`, `max_value`, `unit`; `exercises.exercise_type` dropped. `ExerciseRow` adapts columns by `result_type_slug` (reps/weight → sets + min–max reps; duration/distance/other → sets + target value + unit). New duplicate endpoints: `POST /:id/blocks/:blockId/duplicate`, `POST /:id/blocks/:blockId/exercises/:exId/duplicate`. Exercise selection uses a custom filter-as-you-type combobox. Rest stored as `rest_seconds`, displayed as minutes. `BlockModal`/`ExerciseModal` removed. `[locale]/workouts/` (old flat Workout catalog) is now just a redirect here (#55); `workouts.ts` was removed. |
| Training plan templates | `training-plan-templates.ts` | `[locale]/training-plan-templates/` | Groups Workout Templates into an assignable plan template; tree-grid editor (`TrainingPlanTree.tsx`, #61) with drag-reorder and per-workout weekday. Block/exercise summary formatters are shared with the Workout Templates tree (`workout-templates/summaries.ts`). **Shared builder**: `workout-templates/WorkoutBlockBuilder.tsx` is a self-contained block/exercise editor (its own dnd-kit `DndContext`, `ExerciseCombobox`, inline block/exercise fields, block Duplicate/Delete, cross-block exercise move via drag-and-drop). It accepts `workoutKey` (drag-ID namespace), `blocksUrl` (all API calls are relative to this), `blocks: HierBlock[]`, `canWrite`, `onChanged`. Used by Training Plans workout cards (#164); not used by `WorkoutTemplateTree` (which keeps its own outer `DndContext` for cross-template block moves). |
| Training plans (assigned) | `gym-training-plans.ts`, `training-plans.ts`, `training-plan-creation.ts`, `member-training-plans.ts`, `exercise-logs.ts` | `[locale]/training-plans/` (list, no separate editor page) · also reachable from `[locale]/members/` (`PlanWorkoutBlocksModal.tsx` / `PlanBlockExercisesModal.tsx`) | Per-member cloned plan/workout/block instances (#67, #112, #164). Gym-level list at `/training-plans` renders expandable cards (matching Training Plan Templates UX) — inline metadata editing, workout drag-reorder, block/exercise CRUD **fully inline** (no modals; each workout card embeds `WorkoutBlockBuilder` — see Workout templates row). Context menu per plan: Edit (inline), Details (read-only audit modal), Duplicate (`POST …/duplicate` deep-clones the full tree), Complete (`POST …/complete` stamps end_date and locks the plan read-only), Delete. Two-step **New Training Plan** dialog stays on the list after creation. Cross-parent moves via `PUT …/blocks/:id/move` and `PUT …/exercises/:id/move`. `training-plan-creation.ts` extracts the clone/write-history transaction shared by `POST /training-plans` and legacy `POST /members/:id/member-training-plans`. Lifecycle `draft/active/expired/completed/deleted` on `training_plans.status` (migration 054 adds `expired`; migration 066 adds `completed`); completed plans reject all content mutations with 403. `start_date` required, `end_date` stamped on expire or complete; `member_training_plans` remains the append-only assignment history. `PlanWorkoutBlocksModal.tsx` / `PlanBlockExercisesModal.tsx` are still used on the Members page per-member plan editor (not in the Training Plans list). |
| Audit | `audit-logs.ts` | `[locale]/audit/` (System, gym-scoped, admin+) · `[locale]/cordel/audit/` (Cordel, platform-wide, superadmin) | Both render the shared `AuditLogView` component; platform mode passes `scope="all"` and adds a Gym column. |
| Gyms (platform) | `gyms.ts` (platformRouter) | `[locale]/system/gyms/` (linked from **Cordel → Gyms**) | Superadmin only. Route path kept for URL stability; grouping is Cordel (#66). Migration 095 adds lifecycle/audit columns (`description`, `status` CHECK 'active'/'inactive'/'deleted', `created_by_name`, `modified_at`, `modified_by_name`, `deleted_at`, `deleted_by_name`). Endpoints: `GET /platform/gyms?status=` (list non-deleted, optional status filter), `GET /platform/gyms/:id` (single, including deleted), `POST /platform/gyms` (slug optional, auto-generated), `PUT /platform/gyms/:id` (name/description/status/theme_id, stamps modified_at/modified_by_name), `DELETE /platform/gyms/:id` (soft-delete, stamps deleted_at/deleted_by_name), `POST /platform/gyms/:id/duplicate`. `requireSuperadmin` attaches `req.superadminName` for audit stamping (no extra Clerk API call). Admin page: expandable-row UX, inline creation, context menu Details/Edit/Duplicate/Delete, inline edit with Save/Cancel, Details modal with full audit info. |
| Superadmins | `superadmins.ts` | `[locale]/system/users/` (linked from **Cordel → Users**) | Superadmin only — grant/revoke platform role. Route path kept for URL stability; grouping is Cordel (#66). |
| Themes | `themes.ts` (superadmin Base Themes) + `gym-themes.ts` (gym admin Customer Themes + assignments) | `[locale]/system/themes/` (Cordel → Base Themes, superadmin) + `[locale]/themes/` (System → Themes, gym admin) | #68 + #97 + #117 + #120. `themes.gym_id` (migration 065) distinguishes Base Themes (NULL) from Customer Themes (gym-owned). Gym admins see both via `GET /system/themes`; can clone and edit Customer Themes; can assign any theme (base or customer) as org default or to individual centers. Inline expandable editor has tabs: Branding / Typography / Colors (custom themes only) + Assignments (all themes). Assignments section: org-default checkbox, center list with Inherited/Assigned badges, Restore Inheritance, "+ Assign Centers…" multi-select picker, search filter, show-all pagination. Delete blocked when theme is in use (409). Theme resolution per center: explicit `centers.theme_id` → `gyms.theme_id` → first alphabetically. |
| Recycle Bin | `recycle-bin.ts` | `[locale]/recycle-bin/` (System nav, admin only) | #248. No migrations — all entity tables already have soft-delete columns. `GET /recycle-bin` runs a UNION over `membership_plans`, `promotions`, `centers`, `spaces`, `sellable_item` (gym_charges WHERE is_system=0), `exercises`, `workout_templates`, `training_plan_templates`, `nutrition_plan_templates`, `themes`, returning `{ items, total, limit, offset }` with filters `entity_type`, `q`, `deleted_by_name`, `from`, `to` and sort `entity_type\|name\|deleted_at`. `GET /recycle-bin/:entityType/:id` returns full entity detail bypassing soft-delete guard. `POST /recycle-bin/:entityType/:id/recover` (requireModuleWrite SYSTEM) clears soft-delete columns and restores appropriate status; records audit with `action='restore'`. Two runtime quirks: (1) MySQL 8.4 rejects `?` params for LIMIT/OFFSET on derived-table queries — interpolated as integer literals; (2) `themes` table uses `utf8mb4_unicode_ci` collation, others use `utf8mb4_0900_ai_ci` — `name`/`description` in the themes UNION branch are wrapped with `CONVERT(... USING utf8mb4)`. Entity type `class_package` renamed to `sellable_item` (#271) — the branch now queries `gym_charges WHERE is_system=0`. Admin page: type-filter select, name/deleted-by text search, date range, paginated table, Details modal with entity-specific fields, Recover button. |
| Dashboards | — | `membership`, `organization`, `training`, `nutrition`, `financials` | Placeholder "coming soon" shells. |

Shared admin components (`apps/admin/src/components/`): `DataTable`, `CrudModal`, `ConfirmDialog`, `StatusBadge`, `StatusFilter`, `Toast`, `Sidebar`, `NavGroup`, `AppShell`, `TopHeader`, `GymSelector`, `LanguagePicker`, `ThemeProvider`, `ui.tsx`. Use these in every new page — don't hand-roll tables/modals/status chips.

### Member app (`apps/member`)

The member PWA is built out (no longer just a stub). Navigation is a mobile `BottomNav`. Member endpoints live under `/me/*` (`me.ts`, all `requireRole('member')`).

| Route | Backend (`/me/*`) | Notes |
|-------|-------------------|-------|
| Home (`/:locale`) | — | Public. Sign-in CTA when unauthenticated. |
| `/link` (first login) | `POST /me/link` | Links Clerk user to a `members` row. |
| (app bootstrap) | `GET /me/gym` | Resolves the caller's gym + assigned theme in one call; no `x-gym-id` required. `AppContext` calls this on mount. |
| `/schedule` | `GET /me/schedule`, `POST /me/bookings`, `DELETE /me/bookings/:id`, `GET /me/bookings` | Browse sessions by day; book and cancel. `GET /me/schedule` joins `activity_types`+`spaces` and returns `space_name`, `trainer_name`, `can_cancel`. (#324) Adds `?activity_type_id=` filter; new fields `allows_shared_booking`, `is_shareable`, `my_shared_request_id`, `my_shared_request_status`; computed `availability_state` enum (8 values: UNAVAILABLE/BOOKED_BY_MEMBER/AVAILABLE/WAITLISTED_BY_MEMBER/SHARED_REQUESTED_BY_MEMBER/SHARED_REQUEST_AVAILABLE/WAITLIST_AVAILABLE/FULL). |
| `/calendar` | `GET /me/schedule`, `POST /me/shared-training-requests`, `DELETE /me/shared-training-requests/:id` | (#324) FullCalendar v6 member calendar page at `[locale]/calendar/`. Activity-type filter chips. Per-session event color by `availability_state`. Bottom-sheet action panel: Book (AVAILABLE), Join Waitlist (WAITLIST_AVAILABLE), Cancel Booking (BOOKED_BY_MEMBER), Leave Waitlist (WAITLISTED_BY_MEMBER), Request Shared Training (SHARED_REQUEST_AVAILABLE), Cancel Request (SHARED_REQUESTED_BY_MEMBER). `POST /me/shared-training-requests` validates `is_shareable + allows_shared_booking`, returns 409 on duplicate; `DELETE` cancels own pending request. Double-click day → Day view. Feature-flagged: `calendar.member_calendar`. |
| `/notifications` | `GET /me/notifications`, `GET /me/notifications/count`, `PUT /me/notifications/:id/read`, `PUT /me/notifications/read-all` | In-app notification center (#194). Notifications are written fire-and-forget by booking/cancel/session-cancel flows via `sendNotification`/`sendBulkNotification` in `infra/notifications.ts`. `GET /me/notifications` returns `{ items, unread }`. `AppContext` fetches `count` on mount and exposes `unreadNotifications`+`refreshUnreadCount`. BottomNav bell icon shows badge. |
| `/upcoming` | `GET /me/upcoming` | Next 30 days of confirmed session bookings sorted by starts_at. |
| `/activity-history` | `GET /me/activity-history` | Past session bookings paginated, newest first. |
| `/membership` | `GET /me/membership`, `GET /me/billing-events`, `GET /me/class-packages`, `GET /me/promotions` | Current membership, payment history, package credit balance, promotions. |
| `/training` | `GET /me/training-plans`, `GET /me/workout-logs`, `POST /me/workout-logs` | Assigned training plans + set logging. |
| `/profile` | `GET /me/profile` | Member profile. |

---

## Deployment (dev)

All traffic enters through **Traefik on corfront** (`10.0.2.100`), which terminates TLS (Let's Encrypt) for the `vdicube.com` subdomains. Both VPSs are **Oracle Ampere aarch64** — images are built `linux/arm64`-only on GitHub's native ARM runner (`ubuntu-24.04-arm`; never add amd64 back — QEMU emulation times builds out).

| Piece | Public URL | Runs on | Container / image |
|-------|-----------|---------|-------------------|
| API | `https://api.vdicube.com` → corback `10.0.2.101:3000` | "corback" VPS (`150.230.157.145`) | `fitness-api` / GHCR `fitness-api` |
| Admin | `https://admin.vdicube.com` → corfront `:8081` | "corfront" VPS (`10.0.2.100`) | `fitness-admin` / GHCR `fitness-admin` |
| Member | `https://members.vdicube.com` → corfront `:8082` | "corfront" VPS | `fitness-members` (**plural**) / GHCR `fitness-members` |

**Ownership split (important):**
- **Oscar owns the runtime**: rootless Podman under VPS user `podman`, one **Quadlet unit** per container at `/home/podman/.config/containers/systemd/<name>.container` defining ports, env vars, and restart policy. Containers are managed with `systemctl --user {start|stop|restart} <name>`.
- **Our workflows own build + release only**: build arm64 image → push to GHCR → SSH as `podman` → `podman pull` → (API only: run Knex migrations from the image — the DB is VCN-private, CI can't reach it) → `systemctl --user restart <unit>` → health check.
- Workflows must **never** `podman run` the app containers or `podman generate systemd` — that fights the running unit for the port (exit 126) or overwrites Oscar's env config. To change a runtime env var or port, ask Oscar to edit the unit.

Notes:
- API runtime DB config = `CORDEL_FITNESS_DB_HOST/_USER/_PASSWORD/_NAME` (split vars, set in Oscar's unit). Knex migrations still use a single `DATABASE_URL` (deploy passes `DATABASE_URL_MIGRATIONS`).
- Frontends reach the API via `CORDEL_FITNESS_API_URL=https://api.vdicube.com`. API invite emails use `CORDEL_FITNESS_MEMBERS_URL=https://members.vdicube.com`; team invites use `CORDEL_FITNESS_ADMIN_URL`.
- corfront also runs Oscar's `traefik` (:80/:443) and `wordpress_eforge` (:8080) under the same `podman` user — visible in `podman ps`, don't touch.
- Inbound ports are controlled by the **OCI VCN Security List** (cloud console); OS firewalls are disabled. If a port times out from outside but works on localhost, it's the Security List.
- Traefik config lives on corfront at `/srv/containers/traefik/config/dynamic/backend.yml` (managed by Oscar).
- Diagnostics: `test-ssh.yml` / `test_ssh_corfront.yml` (workflow_dispatch) print identity/ports/`podman ps`; `debug-vps.yml` does deeper corback checks.
- Legacy names are fully retired: `gymdesk-*` containers/images, VPS user `github`, Vercel, `backend-dev.gymdesk.uk` — do not reference them.

---

## CI/CD Configuration (GitHub Actions)

Config is split by scope. **Environment-dependent** values live in GitHub *Environments* (repo Settings → Environments); workflows declare `environment: dev` and read them via `secrets.*` / `vars.*`. When PRO arrives, create a `production` environment with the same names and point its workflows at it — no workflow rewrites needed.

### Environment-scoped (per env: `dev` today, `production` later)

| Name | Kind | Used by |
|------|------|---------|
| `CORDEL_FITNESS_DB_HOST/_USER/_PASSWORD/_NAME` | secrets | (reserved — runtime DB config lives in Oscar's unit; kept in sync here) |
| `DATABASE_URL_MIGRATIONS` | secret | `deploy.yml` — Knex migrations on the VPS (DDL user `fitness_deploy`) |
| `DATABASE_URL_MYSQL` | secret | `debug-vps.yml` — connectivity probe (DML user `fitness`) |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | secrets | CI + deploys (Clerk test instance in dev) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | secret | Frontend builds (baked as build arg) |
| `CORDEL_FITNESS_MEMBERS_URL`, `CORDEL_FITNESS_ADMIN_URL` | variables | App URLs for invite emails |

### Repo-scoped (cross-env)

| Name | Kind | Notes |
|------|------|-------|
| `GHCR_PAT` | secret | Container registry access, shared |
| `CORBACK_SSH_HOST`, `CORBACK_SSH_PRIVATE_KEY` | secret | SSH as user `podman` on corback |
| `CORFRONT_SSH_HOST`, `CORFRONT_SSH_PRIVATE_KEY` | secret | SSH as user `podman` on corfront |

CI (`ci.yml`) runs migrations against a **throwaway MySQL 8.4 service container** (schema `fitness`, plain `DATABASE_URL`) — the real HeatWave DB is unreachable from CI runners.

### Workflows

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Lint/build + migrations against a throwaway MySQL 8.4 service |
| `deploy.yml` | Build/push `fitness-api`, run migrations on the VPS, restart |
| `deploy-admin.yml` | Build/push/restart `fitness-admin` |
| `deploy-member.yml` | Build/push/restart `fitness-members` |
| `debug-vps.yml`, `test-ssh.yml`, `test_ssh_corfront.yml` | Diagnostics (workflow_dispatch) |

---

## Observability

### Structured logging (pino)

The API uses `pino` for structured JSON logging to stdout.

- **`api/src/lib/logger.ts`** — singleton logger. Set `LOG_LEVEL` env var (`debug` / `info` / `warn` / `error`; default `info`). In dev (`NODE_ENV !== 'production'`) output is formatted by `pino-pretty`; in production it emits raw JSON picked up by journald.
- **`api/src/middleware/requestLogger.ts`** — `pino-http` middleware mounted first in `app.ts`. Auto-logs every request/response with method, url, status, response time, and a unique `requestId`. All handlers can call `req.log.info(...)` to emit correlated log lines.
- **Never log**: card numbers, CVV, full payment token values, or member emails at DEBUG level. Only log IDs and status codes.

Payment-flow log convention:
```ts
req.log.info({ orderId, memberId, amount, provider }, 'Payment request created')
req.log.error({ orderId, err: e.message }, 'Provider API call failed')
```

### Log shipping (Phase 0b)

Grafana Alloy ships journald entries from both VPS to Grafana Cloud Loki.

**Architecture**:
```
corback (fitness-api)          corfront (fitness-admin, fitness-members)
    journald                          journald
       ↓                                 ↓
  alloy (systemd)               alloy (systemd)
       └──────────── Grafana Cloud Loki (xavieregea-logs) ────────────┘
                              ↓
                    Grafana Cloud UI / alerts
```

**Config files**: `infra/alloy/config-corback.alloy`, `infra/alloy/config-corfront.alloy`, `infra/alloy/alloy.service`.

**Deployment**: Handled by `.github/workflows/deploy-alloy.yml` on push to `main`. The workflow SSHs into each VPS, downloads the Alloy arm64 binary, writes the config and unit file, and restarts the service. The API key is read from `~/.config/alloy/secrets` (not in git) as `GRAFANA_CLOUD_API_KEY`.

**Querying**: `{container="fitness-api"} |= "ord-001"` traces a single payment order across all log lines.

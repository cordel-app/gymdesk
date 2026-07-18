# Gymdesk Architecture

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
    domain/types.ts                # Shared TypeScript interfaces
    infra/
      db.ts                        # mysql2 pool + query/transaction helpers
      tenantContext.ts             # Middleware: resolves gym role, requireRole(), requireSuperadmin
      audit.ts                     # recordAudit() — fire-and-forget audit_logs writer
      migrations/                  # Knex migration .js files (001_ … 052_)
      swagger.ts                   # OpenAPI spec served at GET /docs
      seed.ts                      # Dev seed (sets a Clerk user as platform superadmin)
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

`GymRole` (the DB-backed role type) is `admin | coach | staff | member`. `superadmin` is a **platform** role stored in Clerk, not a `gym_memberships` value. `guest` is anonymous (public routes only).

| Role | Scope | Who | How identified |
|------|-------|-----|----------------|
| `superadmin` | Platform | Cordel internal | Clerk `publicMetadata.platform_role === 'superadmin'` |
| `admin` | Gym | Gym/studio owner | `gym_memberships.role` |
| `coach` | Gym | Trainer | `gym_memberships.role` (+ trainer specialities) |
| `staff` | Gym | Front desk | `gym_memberships.role` |
| `member` | Gym | Gym member/client | `gym_memberships.role` + `members.clerk_user_id` |
| `guest` | Public | Anonymous visitor | No auth — `/public/*` routes only |

### Permission model (verified against routers)

Reads (`GET`) on gym-scoped domain routes are open to any authenticated gym role (tenantContext alone). Writes are gated with `requireRole(...)`. Source of truth is each router; the table below summarizes the current guards:

| Domain (router) | Read | Create / Update | Delete | Notes |
|---|---|---|---|---|
| Members (`members`) | any role | `admin`, `staff` | `admin` | Soft-delete + `/restore`; `/:id/invite`, `/:id/reinvite`, `/:id/revoke-invite` = `admin`,`staff`. |
| Team (`gym-users`) | `admin` | `admin` | `admin` | Whole router is admin-only (see Team management). |
| Rooms, Specialities, Class types, Class packages, Promotions, Plans (`membership-plans`) | any role | `admin` | `admin` | Admin-only CRUD lookups/catalogs. |
| Trainers (`trainers`) | any role | `admin` (PUT specialities) | — | Trainers are `coach` rows; this manages their specialities. |
| Class sessions (`class-sessions`) | any role | `admin`, `coach`, `staff` | (cancel) `admin`,`coach`,`staff` | `POST /:id/cancel` instead of hard delete. |
| Bookings (`bookings`) | any role | `admin`, `staff` (create) | `admin`, `staff` | `POST /:id/attendance` = `admin`,`staff`,`coach`. |
| Exercises, Workout templates, Training templates | any role | `admin`, `coach` | `admin`, `coach` | `POST /exercises/import-defaults` seeds a per-gym catalog. Deletes are soft (#62). Muscles are a static read-only catalog (`GET /muscles`, no writes — see `domain/muscles.ts`). |
| Training plans (gym-level `training-plans` + `members/:id/training-plans`) | any role | `admin`, `coach` | `admin`, `coach` | Personalized plans (#67). `POST /training-plans` creates from a template or from scratch; if the member already has Active plans and the client hasn't decided keep-vs-expire it returns `409 { active_count }`. `on_existing_active: 'expire'` closes those plans atomically (`status='expired'`, `end_date` = the new plan's `start_date`) plus their `member_training_plans` history rows. Nested content mutations stay on `/members/:id/training-plans/…` (workouts/blocks/exercises with cross-parent moves + duplicate at every level). |
| User memberships (`user-memberships`) | any role | `admin`, `staff` | `admin` | Status changes write a `status_changed` billing event in the same tx. |
| Billing ledger (`billing-events`) | `admin`, `staff` | `admin`, `staff` (POST) | — | Append-only. |
| Audit log (`audit-logs`) | `admin` (default gym scope) · `superadmin` (`?scope=all`) | — | — | Read-only viewer. `?scope=all` (superadmin-only via `tenantCtx.isSuperadmin`) lifts the gym filter and joins `gyms.name`; optional `?gym_id=` narrows the platform view (#66). |
| Action types (`action-types`) | any role | — | — | Global lookup (no `gym_id`), seeded in migration. |
| Public (`public/*`) | guest | — | — | Gym landing + class list by slug. |
| Platform (`platform/*`, `platform/superadmins`) | `superadmin` | `superadmin` | `superadmin` | Gym creation/list; superadmin management. |

Usage in routes:
```ts
router.delete('/:id', requireRole('admin'), handler);
router.post('/',      requireRole('admin', 'staff'), handler);
router.post('/',      requireRole('admin', 'coach'), handler);   // training/workouts
// Public routes — no middleware at all:
app.use('/public', publicRouter);
```

### Platform superadmin (Clerk metadata)
- `requireSuperadmin` middleware checks `user.publicMetadata.platform_role === 'superadmin'`.
- Used for `/platform/*` (gym creation, full gym list) and `/platform/superadmins` (grant/revoke platform role).
- `tenantContext` grants superadmins a synthetic `admin` role for any gym, so they can access all domain routes.
- Frontend: `GymContext` exposes `isSuperadmin` from Clerk's `useUser()`.
- `infra/seed.ts` bootstraps the first superadmin from `SEED_USER_ID`.

---

## Multi-tenancy Pattern

Every domain table has `gym_id CHAR(36) REFERENCES gyms`. Every query filters by it:

```sql
SELECT * FROM members WHERE gym_id = ? AND deleted_at IS NULL
```

The frontend sends `x-gym-id` on every request via `apiFetch()`, which reads it from `GymContext.activeGymId`. Global lookup tables (`benefit_types`, `charge_types`, `action_types`) are the deliberate exception — they have no `gym_id` and are seeded in their migrations.

---

## Database Conventions

- **Migrations**: Knex JS files in `infra/migrations/`. Numbered sequentially (`001_` … `052_`). Run with `npm run db:migrate`. ⚠️ MySQL DDL is **non-transactional** — a failed migration leaves partial state, so keep migrations small and re-runnable (guard `ALTER`s with `hasColumn`/information_schema checks — see `030_gym_theme.js`).
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
app.use('/exercises',              requireAuth(), tenantContext, exercisesRouter);
app.use('/workouts',               requireAuth(), tenantContext, workoutsRouter);
app.use('/training-plan-templates',requireAuth(), tenantContext, trainingPlanTemplatesRouter);
app.use('/training-plans',         requireAuth(), tenantContext, gymTrainingPlansRouter);        // #67
app.use('/members/:memberId/training-plans',        requireAuth(), tenantContext, trainingPlansRouter);
app.use('/members/:memberId/member-training-plans', requireAuth(), tenantContext, memberTrainingPlansRouter);
app.use('/members/:memberId/workout-logs',   requireAuth(), tenantContext, memberWorkoutLogsRouter);
app.use('/audit-logs',             requireAuth(), tenantContext, auditLogsRouter);
app.use('/membership-plans',       requireAuth(), tenantContext, membershipPlansRouter);
app.use('/membership-plans/:id/class-types', requireAuth(), tenantContext, planClassTypesRouter);
app.use('/benefit-types',          requireAuth(), tenantContext, benefitTypesRouter);
app.use('/charge-types',           requireAuth(), tenantContext, chargeTypesRouter);
app.use('/billing-events',         requireAuth(), tenantContext, billingEventsRouter);
app.use('/rooms',                  requireAuth(), tenantContext, roomsRouter);
app.use('/specialities',           requireAuth(), tenantContext, specialitiesRouter);
app.use('/trainers',               requireAuth(), tenantContext, trainersRouter);
app.use('/class-types',            requireAuth(), tenantContext, classTypesRouter);
app.use('/class-sessions',         requireAuth(), tenantContext, classSessionsRouter);
app.use('/class-packages',         requireAuth(), tenantContext, classPackagesRouter);
app.use('/action-types',           requireAuth(), tenantContext, actionTypesRouter);
app.use('/promotions',             requireAuth(), tenantContext, promotionsRouter);
app.use('/promotions/:id',         requireAuth(), tenantContext, promotionDetailsRouter);
app.use('/members/:memberId/class-packages', requireAuth(), tenantContext, userClassPackagesRouter);

// package-credits registers a booking-lifecycle hook as a side-effect import
// (imported BEFORE plan-class-types so its hook queues first).
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
- **`entity_name`** — resolved by `infra/audit-registry.ts` at write time. Named entities (those with a `name` column) use a registry lookup; M-N/link entities (e.g. `user_membership`) get a composed label from their FK parents. Callers may pass `entityName` directly to skip the lookup.
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
| Financials | `admin` | Dashboard, Plans, Promotions |
| System | `admin` | Audit log (gym-scoped) |
| Cordel | `superadmin` | Gyms, Users, Audit log (platform-wide, `/cordel/audit`), Themes |

The per-group "Dashboard" pages (Organization, Training, Nutrition, Financials, plus the singular `/membership`) are **placeholder shells** ("coming soon") today. Some functional pages (e.g. `/memberships` — the user-membership manager with ledger + promotion-apply modals — and `/schedule`) exist and are reachable but are not yet linked from a nav group.

### AppShell (admin)
Wraps all admin pages. Hides sidebar + header for sign-in/sign-up and the unauthenticated home page.

### Theming (`ThemeProvider` + per-gym `theme_id`)
Each gym references an optional **Theme** entity (`gyms.theme_id`, migration 057, FK on `themes.id`). Themes are platform-managed (superadmin only, **Cordel → Themes**) and carry a versioned `tokens` JSON column covering typography (5 levels × `fontFamily` + `color`) and colors (`appBackground`, `headerBackground`, `headerText`, `headerSeparatorColor`, `headerSeparatorHeight`, `sidebarBackground`, `sidebarText`, `sidebarSelectedBackground`, `sidebarSelectedText`). `ThemeProvider` in both the admin app (`context/GymContext` → `activeGym.theme.tokens`) and the member app (`context/AppContext` → resolved via `GET /me/gym`) writes `--gd-*` CSS variables to `<html>` on gym switch; legacy `--brand`/`--chrome`/`--accent` aliases are preserved. Logos are `MEDIUMBLOB` (≤ 512 KB; allow-list: PNG, SVG, JPEG, WEBP), served public at `GET /themes/:id/logo` (`Cache-Control: immutable`). The member app resolves its gym and theme in one call via `GET /me/gym` (no `x-gym-id` header required).

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
| Rooms | `rooms.ts` | `[locale]/rooms/` | Admin-only CRUD. |
| Specialities | `specialities.ts` | `[locale]/specialities/` | Admin-only CRUD; linked to trainers. |
| Trainers | `trainers.ts` | `[locale]/trainers/` | Lists `coach` members; PUT assigns specialities. |
| Class types | `class-types.ts` | `[locale]/class-types/` | Admin-only CRUD. |
| Class sessions | `class-sessions.ts` | `[locale]/schedule/` | Scheduled instances of a class type (room, trainer, capacity). Create/update/cancel by admin/coach/staff. |
| Bookings | `bookings.ts` | (inside Schedule) | Waitlist, capacity, attendance (`/:id/attendance`). Credit consume/refund hooks via `package-credits`. |
| Plans | `membership-plans.ts`, `plan-class-types.ts` | `[locale]/plans/` | Canonical admin-only CRUD reference. Plan prices (validity windows) + benefits + class-type access. |
| Benefit types | `benefit-types.ts` | (inside Plans) | Global lookup (no `gym_id`), seeded. |
| User memberships | `user-memberships.ts`, `membership-promotions.ts` | `[locale]/memberships/` | Status changes write a `status_changed` billing event in the same tx. Apply promotions to a membership. |
| Billing ledger | `billing-events.ts` | Ledger drawer in `[locale]/memberships/` | Append-only (GET + POST). `status_changed` rows are system-emitted. |
| Charge types | `charge-types.ts` | (inside ledger's Record-payment modal) | Global lookup (no `gym_id`), seeded. |
| Class packages | `class-packages.ts`, `user-class-packages.ts`, `package-credits.ts` | `[locale]/class-packages/` | Catalog + per-member packages + credit transactions; credits consumed/refunded on booking lifecycle. |
| Promotions | `promotions.ts`, `promotion-details.ts`, `action-types.ts` | `[locale]/promotions/` | Admin-only. Plan targeting, charge benefits, period benefits. `action_types` is a global lookup. |
| Exercises / Muscles | `exercises.ts` | `[locale]/exercises/` | Per-gym exercise catalog; admin/coach CRUD; `POST /exercises/import-defaults` seeds defaults. Soft delete (`status='deleted'` + `deleted_at`). Muscles are a static in-app catalog (`domain/muscles.ts`, slug keys on `exercise_muscles.muscle`, labels via admin i18n) — no muscles table or CRUD. `GET /exercises/:id/references` powers the dependency dialog (#62). |
| Workout templates | `workout-templates.ts` | `[locale]/workout-templates/` | Reusable, block-based workout blueprints (blocks + per-block exercises); admin/coach. Tree-grid page (#63): expandable rows lazy-load the full hierarchy (`GET /:id` aggregates blocks+exercises via JSON_ARRAYAGG), blocks/exercises are edited in place (`BlockModal`/`ExerciseModal` on `CrudModal`), and dnd-kit drag-and-drop covers block reorder, exercise reorder, and block moves **between** templates (`PUT /:id/blocks/:blockId/move`, transactional reparent + position recompaction in both parents). List endpoint returns the paginated `{items,total,limit,offset}` shape when `limit`/`offset` are passed (name/created_by/status filters + sort) and the legacy plain array otherwise — the Training Plan editor's workout selector depends on the latter. `created_by_membership_id` (migration 053) feeds the Created By column/filter. Status `active/inactive/deleted` (#62): selectors only offer active templates (`?status=active`), delete is soft, and `GET /workout-templates/:id/references` powers the dependency dialog. Block field visibility is driven by block type via `blockFieldConfig.ts` — see Feature Patterns' config-driven form pattern. `[locale]/workouts/` (old flat Workout catalog) is now just a redirect here (#55); `workouts.ts` was removed. |
| Training plan templates | `training-plan-templates.ts` | `[locale]/training-plan-templates/` | Groups Workout Templates into an assignable plan template; tree-grid editor (`TrainingPlanTree.tsx`, #61) with drag-reorder and per-workout weekday. Block/exercise summary formatters are shared with the Workout Templates tree (`workout-templates/summaries.ts`). |
| Training plans (assigned) | `gym-training-plans.ts`, `training-plans.ts`, `training-plan-creation.ts`, `member-training-plans.ts`, `exercise-logs.ts` | `[locale]/training-plans/` (list + `[id]` editor) · also reachable from `[locale]/members/` (`PlanWorkoutBlocksModal.tsx` / `PlanBlockExercisesModal.tsx`) | Per-member cloned plan/workout/block instances (#67). Gym-level list at `/training-plans` filters by member, source template (or `Custom`), status, created-by, and created/modified date ranges; two-step **New Training Plan** dialog (From Template / From Scratch) posts to `POST /training-plans` and handles the 409 keep-vs-expire prompt (see roles table). The tree-grid editor (`training-plans/[id]/page.tsx`) has a plan header form (name/desc/dates/status), workout drag-reorder, per-row context menus with duplicate at every level, and cross-parent moves via `PUT …/blocks/:id/move` (target workout of same plan) and `PUT …/exercises/:id/move` (target block of same plan) — park-then-recompact in one transaction, same shape as workout-templates' #63 block move. Templates page adds an **Assign Plan to Member** action on active templates that opens the same dialog preselected. `training-plan-creation.ts` extracts the clone/write-history transaction so both `POST /training-plans` and legacy `POST /members/:id/member-training-plans` share one implementation. Lifecycle `draft/active/expired/deleted` on `training_plans.status` (migration 054, existing `inactive` remapped to `expired`); `start_date` required, `end_date` stamped on expire; `member_training_plans` remains the append-only assignment history. |
| Audit | `audit-logs.ts` | `[locale]/audit/` (System, gym-scoped, admin+) · `[locale]/cordel/audit/` (Cordel, platform-wide, superadmin) | Both render the shared `AuditLogView` component; platform mode passes `scope="all"` and adds a Gym column. |
| Gyms (platform) | `gyms.ts` (platformRouter) | `[locale]/system/gyms/` (linked from **Cordel → Gyms**) | Superadmin only. Route path kept for URL stability; grouping is Cordel (#66). |
| Superadmins | `superadmins.ts` | `[locale]/system/users/` (linked from **Cordel → Users**) | Superadmin only — grant/revoke platform role. Route path kept for URL stability; grouping is Cordel (#66). |
| Themes | `themes.ts` (`platformRouter` + public `themesPublicRouter`) | `[locale]/system/themes/` (linked from **Cordel → Themes**) | Superadmin only (#68). Platform-managed Theme entities: draft/active/deleted lifecycle, JSON `tokens` column (typography × 5 levels + 9 color/separator values), optional MEDIUMBLOB logo (≤ 512 KB, PNG/SVG/JPEG/WEBP). Each gym has a nullable `theme_id` FK (migration 057); gym list responses LEFT-JOIN the theme inline. Public logo served at `GET /themes/:id/logo` (`Cache-Control: immutable`). Deleted blocked when assigned to any gym (409). |
| Dashboards | — | `membership`, `organization`, `training`, `nutrition`, `financials` | Placeholder "coming soon" shells. |

Shared admin components (`apps/admin/src/components/`): `DataTable`, `CrudModal`, `ConfirmDialog`, `StatusBadge`, `StatusFilter`, `Toast`, `Sidebar`, `NavGroup`, `AppShell`, `TopHeader`, `GymSelector`, `LanguagePicker`, `ThemeProvider`, `ui.tsx`. Use these in every new page — don't hand-roll tables/modals/status chips.

### Member app (`apps/member`)

The member PWA is built out (no longer just a stub). Navigation is a mobile `BottomNav`. Member endpoints live under `/me/*` (`me.ts`, all `requireRole('member')`).

| Route | Backend (`/me/*`) | Notes |
|-------|-------------------|-------|
| Home (`/:locale`) | — | Public. Sign-in CTA when unauthenticated. |
| `/link` (first login) | `POST /me/link` | Links Clerk user to a `members` row. |
| (app bootstrap) | `GET /me/gym` | Resolves the caller's gym + assigned theme in one call; no `x-gym-id` required. `AppContext` calls this on mount. |
| `/schedule` | `GET /me/schedule`, `POST /me/bookings`, `DELETE /me/bookings/:id`, `GET /me/bookings` | Browse sessions, book, cancel, view bookings. |
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

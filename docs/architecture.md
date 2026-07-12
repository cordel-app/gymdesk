# Gymdesk Architecture

## Overview

Multi-tenant Gym Management SaaS. One Express backend, two Next.js frontends (admin + member), one MySQL 8 database (Oracle HeatWave in deployed environments; schema `fitness`). Authentication via Clerk. Tenant isolation via `gym_id` on every domain table and `x-gym-id` request header.

---

## Monorepo Layout

```
gymdesk/
  api/src/                         # Express API (shared by both frontends)
    index.ts                       # App entrypoint, route registration, requireAuth()
    api/                           # One file per domain (members.ts, classes.ts, …)
    domain/types.ts                # Shared TypeScript interfaces
    infra/
      db.ts                        # mysql2 pool + query/transaction helpers
      tenantContext.ts             # Middleware: resolves gym role, enforces requireRole()
      migrations/                  # Knex migration .js files (001_, 002_, …)
      swagger.ts
      seed.ts
  apps/
    admin/src/                     # Staff/admin Next.js app (port :8081 both locally and deployed)
      app/[locale]/                # Next.js App Router pages (one folder per domain)
      components/
        Sidebar.tsx                # Nav — conditionally renders links by role
        AppShell.tsx               # Layout wrapper (hidden for unauthenticated home)
        TopHeader.tsx
        GymSelector.tsx
      context/GymContext.tsx       # Active gym, role, isSuperadmin — loaded everywhere
      lib/apiClient.ts             # apiFetch() — attaches Bearer token + x-gym-id
      middleware.ts                # Clerk auth + next-intl locale routing
      locales/base/en.json …
    member/src/                    # Member-facing PWA (port :8082 both locally and deployed)
      app/[locale]/                # Public home, sign-in, bookings, subscriptions, profile
      app/api/proxy/[...path]/     # Proxy → backend (Node runtime — edge fetch can't reach port 3000)
      context/AppContext.tsx       # gymId + linked member profile
      lib/apiClient.ts
      middleware.ts                # Public routes: /, /:locale, /classes, /sign-in, /api/proxy
      locales/base/en.json …
  shared/                          # Placeholder for future shared services
  docs/                            # This folder
```

---

## Authentication & Authorization

### Auth (Clerk)
- `requireAuth()` in `index.ts` verifies the Clerk Bearer token on every protected route.
- Decoded `userId` is attached as `req.auth.userId`.

### Tenant context (`infra/tenantContext.ts`)
- Reads `x-gym-id` header, looks up `gym_memberships` to get the user's `role` in that gym.
- Attaches `req.tenantCtx = { userId, gymId, role }`.
- Helper `getTenantContext(req)` retrieves it safely inside route handlers.

### Roles

| Role | Scope | Who | How identified |
|------|-------|-----|----------------|
| `superadmin` | Platform | Cordel internal | Clerk `publicMetadata.platform_role === 'superadmin'` |
| `admin` | Gym | Gym/studio owner | `gym_memberships.role` |
| `coach` | Gym | Trainer | `gym_memberships.role` |
| `staff` | Gym | Front desk | `gym_memberships.role` |
| `member` | Gym | Gym member/client | `gym_memberships.role` + `members.clerk_user_id` |
| `guest` | Public | Anonymous visitor | No auth — `/public/*` routes only |

### Permission matrix

| Endpoint | superadmin | admin | coach | staff | member | guest |
|----------|-----------|-------|-------|-------|--------|-------|
| GET /members | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT /members | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| DELETE /members | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| POST /members/:id/invite | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| GET /classes | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT /classes | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| DELETE /classes | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| GET /bookings | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT /bookings | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| DELETE /bookings | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| GET /user-memberships | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT /user-memberships | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| DELETE /user-memberships | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| GET /membership-plans, /benefit-types, /charge-types | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT/DELETE /membership-plans | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| GET/POST /billing-events | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| POST /me/link | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| GET /me/profile | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| GET /me/bookings | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| GET /me/subscriptions | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| GET /public/gyms/:slug | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET /public/gyms/:slug/classes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| /platform/* | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

Usage in routes:
```ts
router.delete('/:id', requireRole('admin'), handler);
router.post('/',      requireRole('admin', 'staff'), handler);
// Public routes — no middleware at all:
app.use('/public', publicRouter);
```

### Platform superadmin (Clerk metadata)
- `requireSuperadmin` middleware checks `user.publicMetadata.platform_role === 'superadmin'`.
- Only used for `/platform/*` routes (gym creation, full gym list).
- `tenantContext` grants superadmins synthetic `admin` role for any gym, so they can access all domain routes.
- Frontend: `GymContext` exposes `isSuperadmin` from Clerk's `useUser()`.

---

## Multi-tenancy Pattern

Every domain table has `gym_id CHAR(36) REFERENCES gyms`. Every query filters by it:

```sql
SELECT * FROM members WHERE gym_id = ? AND deleted_at IS NULL
```

The frontend sends `x-gym-id` on every request via `apiFetch()`, which reads it from `GymContext.activeGymId`.

---

## Database Conventions

- **Migrations**: Knex JS files in `infra/migrations/`. Numbered sequentially (`001_`, `002_`, …). Run with `npm run db:migrate`. ⚠️ MySQL DDL is **non-transactional** — a failed migration leaves partial state, so keep migrations small and re-runnable.
- **Primary keys**: auto-increment `INT UNSIGNED` for domain tables, `CHAR(36)` UUID for `gyms` (tenant root, `DEFAULT (UUID())`).
- **Timestamps**: `DATETIME`, always UTC (the mysql2 pool uses `timezone: 'Z'`; use `UTC_TIMESTAMP()` in SQL, never `NOW()`).
- **Indexed text columns**: `VARCHAR(n)`, not `TEXT` (MySQL cannot index TEXT without a prefix length).
- **Soft deletes**: Add `deleted_at DATETIME` and filter `WHERE deleted_at IS NULL`. Used for members; consider for other user-facing entities.
- **Cascade**: FK `ON DELETE CASCADE` when the child has no meaning without the parent (e.g. `fares → gyms`). Use `ON DELETE SET NULL` when the reference is optional (e.g. `members.fare_id → fares`).
- **Duplicates**: unique-key violations surface as `err.code === 'ER_DUP_ENTRY'` (errno 1062) → return 409.
- **No partial/filtered indexes** in MySQL: for "unique among non-deleted/active rows" use a generated column + unique index.
- **Inserts**: no `RETURNING` in MySQL — insert, then `SELECT` by `insertId` (returned by the `db.query` helper). Upserts use `INSERT ... AS new ON DUPLICATE KEY UPDATE col = new.col`; "insert if absent" uses `INSERT IGNORE`.

---

## Backend Route Registration (`index.ts`)

```ts
// Member self-service — auth required, NO tenant context (links Clerk user to member row)
app.use('/me/link', requireAuth(), meLinkRouter);

// Member self-service — auth + tenant context (member role only)
app.use('/me', requireAuth(), tenantContext, meRouter);

// No tenant context needed (gym not selected yet)
app.use('/gyms',    requireAuth(), gymsRouter);
app.use('/platform',requireAuth(), platformRouter);   // superadmin only

// All domain routes — auth + tenant context required
app.use('/members',          requireAuth(), tenantContext, membersRouter);
app.use('/classes',          requireAuth(), tenantContext, classesRouter);
app.use('/bookings',         requireAuth(), tenantContext, bookingsRouter);
app.use('/user-memberships', requireAuth(), tenantContext, userMembershipsRouter);
app.use('/membership-plans', requireAuth(), tenantContext, membershipPlansRouter);
app.use('/benefit-types',    requireAuth(), tenantContext, benefitTypesRouter);
app.use('/charge-types',     requireAuth(), tenantContext, chargeTypesRouter);
app.use('/billing-events',   requireAuth(), tenantContext, billingEventsRouter);

// Legacy — kept mounted until their replacement frontend ships, then DELETE:
app.use('/subscriptions', requireAuth(), tenantContext, subscriptionsRouter); // replaced by /user-memberships (P1.5); page replaced in P1.7
```

### Member invite + auto-link flow

1. Staff calls `POST /members/:id/invite` → Clerk sends invitation email with redirect URL `MEMBER_APP_URL/en/link?gym_id=...`
2. Member clicks email link, signs in via Clerk in `apps/member`
3. On first sign-in, app calls `POST /me/link` (no gym_memberships row yet) — backend matches by email + gym_id, sets `members.clerk_user_id`, inserts `gym_memberships(role='member')`
4. Subsequent requests use `/me/*` routes with `tenantContext` resolving the member role normally

---

## Frontend Patterns

Both frontends follow the same proxy + context pattern. The admin app uses `GymContext`; the member app uses `AppContext`.

### API calls
All requests go through `apiFetch()` (from `useApiClient()`), which:
1. Gets a fresh Clerk token.
2. Attaches `Authorization: Bearer <token>`.
3. Attaches `x-gym-id: <activeGymId>`.
4. Hits `/api/proxy/<path>` → Next.js proxy route → backend. The proxy MUST stay on the Node runtime (no `runtime = 'edge'`). The API has no CORS — it is reachable only through these proxies. The proxy target is `CORDEL_FITNESS_API_URL` (deployed: `https://api.vdicube.com` — public URL through Traefik, deliberate choice for flexibility; local dev: `http://localhost:3000`).

### Backoffice: GymContext
Available via `useGym()`. Key fields:
```ts
activeGymId: string | null
activeGym: { id, name, slug, role } | null
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

### AppShell (admin)
Wraps all admin pages. Hides sidebar + header for:
- Sign-in / sign-up pages
- Home page (`/:locale`) when user is not authenticated

### Middleware (both apps)
Both apps use `clerkMiddleware` + `next-intl` middleware together. Public routes bypass `auth.protect()`. Both apps require `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (baked at build time) and `CLERK_SECRET_KEY` (runtime) as env vars (baked as Docker build args / runtime env).

### Sidebar visibility (admin)
- Regular links: visible to all authenticated gym members.
- Admin-only links (e.g. Plans): check `activeGym?.role === 'admin' || isSuperadmin`.
- Superadmin-only section (System > Gyms): check `isSuperadmin`.

### i18n
All strings live in each app's `locales/base/{en,es,ca}.json`, namespaced by feature. Use `useTranslations()` in every page/component.

---

## Existing Domain Modules

### Admin (`apps/admin`)

| Module | Backend | Frontend page | Notes |
|--------|---------|---------------|-------|
| Members | `api/members.ts` | `[locale]/members/` | Canonical staff-level CRUD reference. Soft-delete + restore. Has `clerk_user_id` column. |
| Classes | `api/classes.ts` | `[locale]/classes/` | |
| Bookings | `api/bookings.ts` | `[locale]/bookings/` | |
| Plans | `api/membership-plans.ts` | `[locale]/plans/` | Canonical admin-only CRUD reference. Includes plan prices (validity windows) + benefits. Replaced Fares (P1.1/P1.2). |
| Benefit types | `api/benefit-types.ts` | (used inside Plans) | Global lookup table (no `gym_id`), seeded in its migration. |
| User memberships | `api/user-memberships.ts` | `[locale]/memberships/` | Replaced Subscriptions (P1.5/P1.7). Status changes write a `status_changed` billing event in the same transaction. Members page reads plans from `/membership-plans?status=active`. |
| Billing ledger | `api/billing-events.ts` | Ledger drawer inside `[locale]/memberships/` | Append-only: GET (paginated, filter by member/membership/type/date) + POST only. `status_changed` rows are system-emitted, not POSTable. |
| Charge types | `api/charge-types.ts` | (used inside the ledger drawer's Record payment modal) | Global lookup table (no `gym_id`), seeded in its migration. |
| Gyms (platform) | `api/gyms.ts` (platformRouter) | `[locale]/system/gyms/` | Superadmin only. |

Shared admin components (P0.1/P0.2, in `apps/admin/src/components/`): `DataTable`, `CrudModal`, `ConfirmDialog`, `StatusBadge`, `StatusFilter`, `Toast`. Use these in every new page — don't hand-roll tables/modals. Member app has `BottomNav` (P0.3).

### Member app (`apps/member`) — in progress

| Route | Backend | Notes |
|-------|---------|-------|
| Home | — | Public. Shows Sign In button if unauthenticated. |
| `/link` | `POST /me/link` | First-login: links Clerk user to members row. |
| `/bookings` | `GET /me/bookings` | Member only. |
| `/subscriptions` | `GET /me/subscriptions` | Member only. |
| `/profile` | `GET /me/profile` | Member only. |

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
- Frontends reach the API via `CORDEL_FITNESS_API_URL=https://api.vdicube.com` (public URL through Traefik — Oscar's deliberate choice for flexibility; traffic stays in the Frankfurt region). API invite emails use `CORDEL_FITNESS_MEMBERS_URL=https://members.vdicube.com`.
- corfront also runs Oscar's `traefik` (:80/:443) and `wordpress_eforge` (:8080) under the same `podman` user — visible in `podman ps`, don't touch.
- Inbound ports are controlled by the **OCI VCN Security List** (cloud console); OS firewalls are disabled. If a port times out from outside but works on localhost, it's the Security List.
- Traefik config lives on corfront at `/srv/containers/traefik/config/dynamic/backend.yml` (managed by Oscar).
- Diagnostics: `test-ssh.yml` (workflow_dispatch) prints identity/ports/`podman ps` on both VPSs; `debug-vps.yml` does deeper corback checks.
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
| `CORDEL_FITNESS_MEMBERS_URL` | variable | Member-app URL for invite emails |

### Repo-scoped (cross-env)

| Name | Kind | Notes |
|------|------|-------|
| `GHCR_PAT` | secret | Container registry access, shared |
| `CORBACK_SSH_HOST`, `CORBACK_SSH_PRIVATE_KEY` | secret | SSH as user `podman` on corback |
| `CORFRONT_SSH_HOST`, `CORFRONT_SSH_PRIVATE_KEY` | secret | SSH as user `podman` on corfront |

CI (`ci.yml`) runs migrations against a **throwaway MySQL 8.4 service container** (schema `fitness`, plain `DATABASE_URL`) — the real HeatWave DB is unreachable from CI runners.

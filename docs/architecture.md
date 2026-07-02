# Gymdesk Architecture

## Overview

Multi-tenant Gym Management SaaS. One Express backend, one Next.js frontend, one PostgreSQL database. Authentication via Clerk. Tenant isolation via `gym_id` on every domain table and `x-gym-id` request header.

---

## Monorepo Layout

```
gymdesk/
  backend/src/                     # Express API (shared by both frontends)
    index.ts                       # App entrypoint, route registration, requireAuth()
    api/                           # One file per domain (members.ts, classes.ts, …)
    domain/types.ts                # Shared TypeScript interfaces
    infra/
      db.ts                        # pg Pool
      tenantContext.ts             # Middleware: resolves gym role, enforces requireRole()
      migrations/                  # node-pg-migrate .js files (001_, 002_, …)
      swagger.ts
      seed.ts
  apps/
    backoffice/src/                # Staff/admin Next.js app (port 3001)
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
    app/src/                       # Member-facing PWA (port 3002)
      app/[locale]/                # Public home, sign-in, bookings, subscriptions, profile
      app/api/proxy/[...path]/     # Edge proxy → backend
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
| GET /subscriptions | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT /subscriptions | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| DELETE /subscriptions | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| GET /fares | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| POST/PUT/DELETE /fares | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
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

Every domain table has `gym_id uuid REFERENCES gyms`. Every query filters by it:

```sql
SELECT * FROM members WHERE gym_id = $1 AND deleted_at IS NULL
```

The frontend sends `x-gym-id` on every request via `apiFetch()`, which reads it from `GymContext.activeGymId`.

---

## Database Conventions

- **Migrations**: `node-pg-migrate` JS files in `infra/migrations/`. Numbered sequentially (`001_`, `002_`, …). Run with `npm run db:migrate`.
- **Primary keys**: `serial` for domain tables, `uuid` for `gyms` (tenant root).
- **Soft deletes**: Add `deleted_at timestamptz` and filter `WHERE deleted_at IS NULL`. Used for members; consider for other user-facing entities.
- **Cascade**: FK `ON DELETE CASCADE` when the child has no meaning without the parent (e.g. `fares → gyms`). Use `ON DELETE SET NULL` when the reference is optional (e.g. `members.fare_id → fares`).

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
app.use('/members',       requireAuth(), tenantContext, membersRouter);
app.use('/classes',       requireAuth(), tenantContext, classesRouter);
app.use('/bookings',      requireAuth(), tenantContext, bookingsRouter);
app.use('/subscriptions', requireAuth(), tenantContext, subscriptionsRouter);
app.use('/fares',         requireAuth(), tenantContext, faresRouter);
```

### Member invite + auto-link flow

1. Staff calls `POST /members/:id/invite` → Clerk sends invitation email with redirect URL `MEMBER_APP_URL/en/link?gym_id=...`
2. Member clicks email link, signs in via Clerk in `apps/app`
3. On first sign-in, app calls `POST /me/link` (no gym_memberships row yet) — backend matches by email + gym_id, sets `members.clerk_user_id`, inserts `gym_memberships(role='member')`
4. Subsequent requests use `/me/*` routes with `tenantContext` resolving the member role normally

---

## Frontend Patterns

Both frontends follow the same proxy + context pattern. The backoffice uses `GymContext`; the member app uses `AppContext`.

### API calls
All requests go through `apiFetch()` (from `useApiClient()`), which:
1. Gets a fresh Clerk token.
2. Attaches `Authorization: Bearer <token>`.
3. Attaches `x-gym-id: <activeGymId>`.
4. Hits `/api/proxy/<path>` → Next.js Edge proxy → backend.

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

### AppShell (backoffice)
Wraps all backoffice pages. Hides sidebar + header for:
- Sign-in / sign-up pages
- Home page (`/:locale`) when user is not authenticated

### Middleware (both apps)
Both apps use `clerkMiddleware` + `next-intl` middleware together. Public routes bypass `auth.protect()`. Both apps require `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (baked at build time) and `CLERK_SECRET_KEY` (runtime) as Vercel env vars.

### Sidebar visibility (backoffice)
- Regular links: visible to all authenticated gym members.
- Admin-only links (e.g. Fares): check `activeGym?.role === 'admin' || isSuperadmin`.
- Superadmin-only section (System > Gyms): check `isSuperadmin`.

### i18n
All strings live in each app's `locales/base/{en,es,ca}.json`, namespaced by feature. Use `useTranslations()` in every page/component.

---

## Existing Domain Modules

### Backoffice (`apps/backoffice`)

| Module | Backend | Frontend page | Notes |
|--------|---------|---------------|-------|
| Members | `api/members.ts` | `[locale]/members/` | Canonical CRUD reference. Soft-delete + restore. Has `clerk_user_id` column. |
| Classes | `api/classes.ts` | `[locale]/classes/` | |
| Bookings | `api/bookings.ts` | `[locale]/bookings/` | |
| Subscriptions | `api/subscriptions.ts` | `[locale]/subscriptions/` | |
| Fares | `api/fares.ts` | `[locale]/fares/` | Admin-only. FK from members.fare_id. |
| Gyms (platform) | `api/gyms.ts` (platformRouter) | `[locale]/system/gyms/` | Superadmin only. |

### Member app (`apps/app`) — in progress

| Route | Backend | Notes |
|-------|---------|-------|
| Home | — | Public. Shows Sign In button if unauthenticated. |
| `/link` | `POST /me/link` | First-login: links Clerk user to members row. |
| `/bookings` | `GET /me/bookings` | Member only. |
| `/subscriptions` | `GET /me/subscriptions` | Member only. |
| `/profile` | `GET /me/profile` | Member only. |

---

## CI/CD Configuration (GitHub Actions)

Config is split by scope. **Environment-dependent** values live in GitHub *Environments* (repo Settings → Environments); workflows declare `environment: dev` and read them via `secrets.*` / `vars.*`. When PRO arrives, create a `production` environment with the same names and point its workflows at it — no workflow rewrites needed.

### Environment-scoped (per env: `dev` today, `production` later)

| Name | Kind | Why per-environment |
|------|------|---------------------|
| `DATABASE_URL` | secret | Each env has its own database |
| `CLERK_SECRET_KEY` | secret | Clerk test instance (dev) vs live instance (PRO) |
| `CLERK_PUBLISHABLE_KEY` | secret | Same |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | secret | Same |
| `MEMBER_APP_URL` | variable | Each env has its own member-app URL |

### Repo-scoped (cross-env)

| Name | Kind | Notes |
|------|------|-------|
| `GHCR_PAT` | secret | Container registry access, shared |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID` | secret | Shared Vercel account |
| `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_ID_APP` | secret | Per-app project ids; move to environments if PRO gets separate Vercel projects |
| `CORBACK_SSH_HOST`, `CORBACK_SSH_PRIVATE_KEY` | secret | Dev VPS. Environment-dependent by nature — move into the `dev` environment when PRO's server exists (values must be re-entered; secrets are write-only) |
| `CORFRONT_SSH_HOST`, `CORFRONT_SSH_PRIVATE_KEY` | secret | Reserved for future frontend VPS |

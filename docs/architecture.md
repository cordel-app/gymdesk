# Gymdesk Architecture

## Overview

Multi-tenant Gym Management SaaS. One Express backend, one Next.js frontend, one PostgreSQL database. Authentication via Clerk. Tenant isolation via `gym_id` on every domain table and `x-gym-id` request header.

---

## Monorepo Layout

```
gymdesk/
  apps/backoffice/
    backend/src/
      index.ts              # Express app, route registration, requireAuth()
      api/                  # One file per domain (members.ts, classes.ts, …)
      domain/types.ts       # Shared TypeScript interfaces
      infra/
        db.ts               # pg Pool
        tenantContext.ts    # Middleware: resolves gym role, enforces requireRole()
        migrations/         # node-pg-migrate .js files (001_, 002_, …)
        swagger.ts
        seed.ts
    frontend/src/
      app/[locale]/         # Next.js App Router pages (one folder per domain)
      components/
        Sidebar.tsx         # Nav — conditionally renders links by role
        AppShell.tsx        # Layout wrapper
        TopHeader.tsx
        GymSelector.tsx
      context/GymContext.tsx # Active gym, role, isSuperadmin — loaded everywhere
      lib/apiClient.ts       # apiFetch() — attaches Bearer token + x-gym-id
      middleware.ts          # next-intl locale routing
  locales/base/
    en.json / es.json / ca.json   # All UI strings, namespaced by feature
  docs/                     # This folder
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
| `guest` | Public | Anonymous visitor | No auth — `/public/*` routes only |

### Permission matrix

| Endpoint | superadmin | admin | coach | staff | guest |
|----------|-----------|-------|-------|-------|-------|
| GET /members | ✓ | ✓ | ✓ | ✓ | ✗ |
| POST/PUT /members | ✓ | ✓ | ✗ | ✓ | ✗ |
| DELETE /members | ✓ | ✓ | ✗ | ✗ | ✗ |
| GET /classes | ✓ | ✓ | ✓ | ✓ | ✗ |
| POST/PUT /classes | ✓ | ✓ | ✓ | ✗ | ✗ |
| DELETE /classes | ✓ | ✓ | ✗ | ✗ | ✗ |
| GET /bookings | ✓ | ✓ | ✓ | ✓ | ✗ |
| POST/PUT /bookings | ✓ | ✓ | ✗ | ✓ | ✗ |
| DELETE /bookings | ✓ | ✓ | ✗ | ✗ | ✗ |
| GET /subscriptions | ✓ | ✓ | ✓ | ✓ | ✗ |
| POST/PUT /subscriptions | ✓ | ✓ | ✗ | ✓ | ✗ |
| DELETE /subscriptions | ✓ | ✓ | ✗ | ✗ | ✗ |
| GET /fares | ✓ | ✓ | ✓ | ✓ | ✗ |
| POST/PUT/DELETE /fares | ✓ | ✓ | ✗ | ✗ | ✗ |
| GET /public/gyms/:slug | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET /public/gyms/:slug/classes | ✓ | ✓ | ✓ | ✓ | ✓ |
| /platform/* | ✓ | ✗ | ✗ | ✗ | ✗ |

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

---

## Frontend Patterns

### API calls
All requests go through `apiFetch()` (from `useApiClient()`), which:
1. Gets a fresh Clerk token.
2. Attaches `Authorization: Bearer <token>`.
3. Attaches `x-gym-id: <activeGymId>`.
4. Hits `/api/proxy/<path>` → Next.js proxy → backend.

### GymContext
Available everywhere via `useGym()`. Key fields:
```ts
activeGymId: string | null
activeGym: { id, name, slug, role } | null
isSuperadmin: boolean
loading: boolean
```

### Sidebar visibility
- Regular links: visible to all authenticated gym members.
- Admin-only links (e.g. Fares): check `activeGym?.role === 'admin' || isSuperadmin`.
- Superadmin-only section (System > Gyms): check `isSuperadmin`.

### i18n
All strings live in `locales/base/{en,es,ca}.json`, namespaced by feature (`members.*`, `fares.*`, etc.). Use `useTranslations()` in every page/component.

---

## Existing Domain Modules

| Module | Backend | Frontend page | Notes |
|--------|---------|---------------|-------|
| Members | `api/members.ts` | `[locale]/members/` | Canonical reference. Has soft-delete + restore. |
| Classes | `api/classes.ts` | `[locale]/classes/` | |
| Bookings | `api/bookings.ts` | `[locale]/bookings/` | |
| Subscriptions | `api/subscriptions.ts` | `[locale]/subscriptions/` | |
| Fares | `api/fares.ts` | `[locale]/fares/` | Admin-only. FK from members.fare_id. |
| Gyms (platform) | `api/gyms.ts` (platformRouter) | `[locale]/system/gyms/` | Superadmin only. |

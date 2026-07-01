# Gymdesk

Gym Management SaaS — backoffice for managing members, classes, bookings, and subscriptions.

## Requirements

- [Node.js](https://nodejs.org/) v20+
- [Clerk](https://clerk.com) account with access to the `gymdesk` application
- [Neon](https://neon.tech) account with access to the `gymdesk` project

## First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Pull all secrets (Clerk + Neon) into local .env files
#    This opens a browser login for each service on first run
npm run env:pull

# 3. Run database migrations
npm run db:migrate
```

That's it — no Docker, no manual `.env` copying.

> **New to the team?** Ask the project owner to grant you access to the Clerk `gymdesk` app and the Neon `gymdesk` project. Once you have access, `npm run env:pull` handles everything automatically.

## Running locally

```bash
# Terminal 1 — backend (http://localhost:3000)
npm run dev:backend

# Terminal 2 — frontend (http://localhost:3001)
npm run dev:frontend
```

## Project structure

```
gymdesk/
  apps/
    backoffice/
      backend/        # Express + TypeScript REST API
        src/
          api/        # Route handlers (members, classes, bookings, subscriptions, gyms)
          domain/     # TypeScript types
          infra/      # Database connection, migrations, seed, tenant context
      frontend/       # Next.js admin dashboard
        src/
          app/        # Pages and layout
          components/ # UI components
          context/    # GymContext (active tenant)
          lib/        # apiClient (authenticated fetch wrapper)
  scripts/
    env-pull.sh       # Developer onboarding script
  skills/
    business/         # Business domain guidelines
    technical/        # Technical conventions
    procedures/       # Operational runbooks
  .github/
    workflows/
      ci.yml          # Type-check + build + migrations on every push
```

## Architecture

- **Auth** — [Clerk](https://clerk.com) handles sign-in, sign-up, and session management
- **Multi-tenant** — each gym is a tenant; all data is scoped by `gym_id`
- **Roles** — `superadmin` (platform-level) · `admin` · `coach` · `staff` (gym-level)
- **Database** — [Neon](https://neon.tech) serverless PostgreSQL

### Role permissions

| Action | superadmin | admin | coach | staff |
|--------|:---:|:---:|:---:|:---:|
| Create / manage gyms | ✓ | | | |
| Assign gym admins | ✓ | | | |
| Manage memberships | | ✓ | | |
| Create / edit members | | ✓ | | ✓ |
| Delete members | | ✓ | | |
| Create / edit classes | | ✓ | ✓ | |
| Delete classes | | ✓ | | |
| Create / edit bookings | | ✓ | | ✓ |
| Delete bookings | | ✓ | | |
| Manage subscriptions | | ✓ | | ✓ |

## Superadmin setup

The first superadmin must be seeded manually once after the database is created:

```bash
SEED_USER_ID=<clerk_user_id> npm run db:seed
```

Find your Clerk user ID in the [Clerk Dashboard](https://dashboard.clerk.com) → Users.

## API endpoints

All endpoints except `GET /health` require a valid Clerk session token (`Authorization: Bearer <token>`) and, for domain routes, an `x-gym-id` header with the active gym's UUID.

| Method | Path | Role required |
|--------|------|---------------|
| GET | /health | — |
| GET | /gyms | any authenticated |
| GET | /gyms/:id/memberships | admin |
| POST | /gyms/:id/memberships | admin |
| DELETE | /gyms/:id/memberships/:userId | admin |
| GET | /platform/gyms | superadmin |
| POST | /platform/gyms | superadmin |
| POST | /platform/gyms/:id/admins | superadmin |
| GET | /members | any gym member |
| POST | /members | admin, staff |
| PUT | /members/:id | admin, staff |
| DELETE | /members/:id | admin |
| GET | /classes | any gym member |
| POST | /classes | admin, coach |
| PUT | /classes/:id | admin, coach |
| DELETE | /classes/:id | admin |
| GET | /bookings | any gym member |
| POST | /bookings | admin, staff |
| PUT | /bookings/:id | admin, staff |
| DELETE | /bookings/:id | admin |
| GET | /subscriptions | any gym member |
| POST | /subscriptions | admin, staff |
| PUT | /subscriptions/:id | admin, staff |
| DELETE | /subscriptions/:id | admin |

## Environment variables

Managed automatically by `npm run env:pull`. Do not commit `.env` files.

**Backend** (`apps/backoffice/backend/.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `CLERK_SECRET_KEY` | Clerk backend secret key |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `PORT` | API port (default: `3000`) |
| `FRONTEND_URL` | Allowed CORS origin (default: `http://localhost:3001`) |
| `SEED_USER_ID` | Clerk user ID for the seed script (one-time use) |

**Frontend** (`apps/backoffice/frontend/.env`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `NEXT_PUBLIC_BACKEND_URL` | Backend base URL (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Sign-in path |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Sign-up path |

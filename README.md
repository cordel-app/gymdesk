# Gymdesk

Gym Management SaaS — admin app for managing members, memberships, classes, bookings, training (exercises, workout templates, training plans), promotions, and billing, plus a member-facing app.

## Requirements

- [Node.js](https://nodejs.org/) v20+
- [Clerk](https://clerk.com) account with access to the `gymdesk` application
- Docker (for the local MySQL 8 database: `npm run db:up`)

## First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Copy .env.example to .env in api/, apps/admin/, apps/member/ and fill in Clerk keys

# 3. Start MySQL and run database migrations
npm run db:up
npm run db:migrate
```



> **New to the team?** Ask the project owner to grant you access to the Clerk `gymdesk` app.

## Running locally

```bash
# Terminal 1 — API (http://localhost:3000)
npm run dev:api

# Terminal 2 — admin app (http://localhost:8081)
npm run dev:admin

# Terminal 3 — member app (http://localhost:8082)
npm run dev:member
```

## Project structure

```
gymdesk/
  api/                # Express + TypeScript REST API (port 3000)
    src/
      api/            # Route handlers (one router per domain module — see docs/architecture.md)
      domain/         # TypeScript types
      infra/          # Database connection, migrations, seed, tenant context
  apps/
    admin/            # Next.js staff/admin dashboard (port 8081)
      src/
        app/          # Pages and layout ([locale] routing)
        components/   # UI components
        context/      # GymContext (active tenant)
        lib/          # apiClient (authenticated fetch wrapper)
    member/           # Next.js member-facing app (port 8082)
  skills/
    business/         # Business domain guidelines
    technical/        # Technical conventions
    procedures/       # Operational runbooks
  docs/               # architecture.md + feature-patterns.md (read before building features)
  .github/
    workflows/        # ci.yml, deploy.yml (api), deploy-admin.yml, deploy-member.yml, migrate-data.yml, debug-vps.yml
```

## Architecture

- **Auth** — [Clerk](https://clerk.com) handles sign-in, sign-up, and session management
- **Multi-tenant** — each gym is a tenant; all data is scoped by `gym_id`
- **Roles** — `superadmin` (platform-level) · `admin` · `coach` · `staff` (gym-level)
- **Database** — MySQL 8 (Oracle HeatWave when deployed; Docker locally)

### Role permissions

| Action | superadmin | admin | coach | staff |
|--------|:---:|:---:|:---:|:---:|
| Create / manage gyms | ✓ | | | |
| Assign gym admins | ✓ | | | |
| Manage plans & billing | | ✓ | | |
| Create / edit members | | ✓ | | ✓ |
| Delete members | | ✓ | | |
| Create / edit class sessions | | ✓ | ✓ | |
| Delete class sessions | | ✓ | | |
| Create / edit bookings | | ✓ | | ✓ |
| Delete bookings | | ✓ | | |
| Manage memberships | | ✓ | | ✓ |
| Manage training catalog (exercises, workout/plan templates) | | ✓ | ✓ | |

## Superadmin setup

The first superadmin must be seeded manually once after the database is created:

```bash
SEED_USER_ID=<clerk_user_id> npm run db:seed
```

Find your Clerk user ID in the [Clerk Dashboard](https://dashboard.clerk.com) → Users.

## API endpoints

All endpoints except `GET /health` and `/public` require a valid Clerk session token (`Authorization: Bearer <token>`); domain routes additionally require an `x-gym-id` header with the active gym's UUID (center-scoped routes accept an optional `x-center-id`).

- **Interactive API docs (Swagger UI)**: `http://localhost:3000/docs` when the API is running.
- **Module → router → page map**: [docs/architecture.md](docs/architecture.md).

Route prefixes by area:

| Area | Route prefixes |
|------|----------------|
| Platform (superadmin) | `/platform`, `/platform/superadmins`, `/gyms` |
| Team & profile | `/gym-users`, `/me`, `/me/link` |
| Membership | `/members`, `/membership-plans`, `/user-memberships`, `/billing-events`, `/benefit-types`, `/charge-types` |
| Classes & booking | `/class-types`, `/class-sessions`, `/bookings`, `/class-packages`, `/members/:memberId/class-packages` |
| Training | `/muscles`, `/exercises`, `/workout-templates`, `/training-plan-templates`, `/members/:memberId/{training-plans,member-training-plans,exercise-logs,workout-block-logs}` |
| Promotions | `/promotions`, `/action-types` |
| Locations (Centers) | `/centers`, `/rooms`, `/resources`, `/events`, `/trainers`, `/trainer-availability`, `/specialities`, `/members/:memberId/centers` |
| System | `/audit-logs`, `/webhooks/clerk`, `/health`, `/public` |

## Environment variables

Copy each `.env.example` to `.env` and fill in values. Do not commit `.env` files.

**API** (`api/.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL connection string (local: `mysql://root:fitness@localhost:3306/fitness`) |
| `CLERK_SECRET_KEY` | Clerk backend secret key |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `PORT` | API port (default: `3000`) |
| `SEED_USER_ID` | Clerk user ID for the seed script (one-time use) |

**Admin** (`apps/admin/.env`) / **Member** (`apps/member/.env`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `NEXT_PUBLIC_BACKEND_URL` | Backend base URL (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Sign-in path |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Sign-up path |

# Gymdesk

Multi-tenant Gym Management SaaS — an admin app for managing members, staff, membership plans (billing policies, center restrictions) and their assignments, promotions, sellable items and taxes, the calendar (classes, events, spaces, operating hours, recurring personal-training bookings), class packages, training (exercises, workout and training-plan templates, member training plans and logs), nutrition (library, plan templates, member nutrition plans), billing and payments (MONEI), financial dashboards, per-gym theming and website self-registration — plus a member-facing app and a hosted payment page.

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
      domain/         # TypeScript types and pure domain helpers
      infra/          # DB connection, migrations, seed, tenant context, permissions, audit, storage
      middleware/     # Express middleware
      payments/       # Payment provider adapters (MONEI)
      lib/            # Logger and shared utilities
      test/           # Vitest unit + integration tests
  apps/
    admin/            # Next.js staff/admin dashboard (port 8081)
      src/
        app/          # Pages and layout ([locale] routing) + /api/proxy to the backend
        components/   # UI components
        config/       # Frontend mirror of the permission matrix
        context/      # GymContext (active tenant)
        lib/          # apiClient (authenticated fetch wrapper)
    member/           # Next.js member-facing app (port 8082)
    payment/          # Static hosted payment page (MONEI card input), served by nginx
  infra/              # Deployment config: alloy (observability), nginx, payment-app
  shared/             # Shared package (placeholder)
  scripts/            # One-off scripts (Postgres → MySQL data migration)
  skills/
    business/         # Business domain guidelines
    technical/        # Technical conventions
    procedures/       # Operational runbooks
    routines/         # Recurring agent routines (issue triage, PR review)
  docs/               # architecture, decisions, feature-patterns, roadmap, go-to-production,
                      # wordpress-integration (read before building features; agents: start at CLAUDE.md)
  .github/
    workflows/        # ci.yml, codeql.yml; deploy.yml (api), deploy-admin.yml, deploy-member.yml,
                      # deploy-payment.yml, deploy-alloy.yml; billing-run.yml and
                      # recurring-booking-run.yml (nightly jobs); debug-vps.yml, test-ssh*.yml
```

## Architecture

- **Auth** — [Clerk](https://clerk.com) handles sign-in, sign-up, and session management
- **Multi-tenant** — each gym is a tenant; all data is scoped by `gym_id`
- **Roles** — `superadmin` is a platform role (Clerk `publicMetadata.platform_role`). Gym-level roles live in `gym_memberships` and are derived from the Staff profile: `admin` (Gym Manager) · `trainer_performance` (Personal Trainer) · `trainer_perf_nutrition` (Personal Trainer & Nutritionist) · `front_desk` · `accountant` · `nutritionist`, plus `member` for the member app
- **Database** — MySQL 8 (Oracle HeatWave when deployed; Docker locally)

### Role permissions

Access is granted per module by the matrix in `api/src/infra/permissions.ts` (mirrored for the sidebar in `apps/admin/src/config/permissions.ts`). **RW** read + write · **R** read-only · **assigned** limited to their own assigned records · **own** own data only, via `/me/*` · — no access.

| Module | admin | trainer_performance | trainer_perf_nutrition | front_desk | accountant | nutritionist | member |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Members | RW | R assigned | R assigned | RW | — | R assigned | own |
| Calendar | RW | RW | RW | RW | — | R | — |
| Organization | RW | R | R | R | — | R | — |
| Training | RW | RW | RW | R | — | R assigned | own |
| Nutrition | RW | R assigned | RW assigned | R | — | RW assigned | own |
| Financials | RW | — | — | R | R | — | — |
| Payments | RW | — | — | RW | R | — | own |
| System | RW | — | — | — | — | — | — |

The **Cordel** area (gyms, platform catalogues, themes, feature flags, payment providers, impersonation, platform-wide audit log) is `superadmin` only.

## Running API tests

Tests use [Vitest](https://vitest.dev/) + [supertest](https://github.com/ladjs/supertest) against a real MySQL database. Clerk is mocked — no live Clerk instance is needed.

**Prerequisites:** MySQL must be running with migrations applied (`npm run db:up && npm run db:migrate`). The test runner picks up `api/.env` automatically.

```bash
npm --workspace api test          # run once
npm --workspace api run test:watch  # watch mode
```

## Superadmin setup

The first superadmin must be seeded manually once after the database is created:

```bash
SEED_USER_ID=<clerk_user_id> npm run db:seed
```

Find your Clerk user ID in the [Clerk Dashboard](https://dashboard.clerk.com) → Users.

This is for local / dev only — the seed script also creates a placeholder gym. For production, see [docs/go-to-production.md](docs/go-to-production.md#3-first-superadmin-bootstrap).

## API endpoints

All endpoints except `GET /health`, `/docs`, `/public`, the webhooks and the internal job runners (`X-Internal-Secret`) require a valid Clerk session token (`Authorization: Bearer <token>`); domain routes additionally require an `x-gym-id` header with the active gym's UUID (center-scoped routes accept an optional `x-center-id`).

- **Interactive API docs (Swagger UI)**: `http://localhost:3000/docs` when the API is running.
- **Module → router → page map**: [docs/architecture.md](docs/architecture.md).

Route prefixes by area:

| Area | Route prefixes |
|------|----------------|
| Platform (superadmin) | `/gyms`, `/platform`, `/platform/{superadmins,themes,feature-flags,payment-providers,impersonation,orphaned-accounts}`, `/platform/{exercises,workout-templates,training-plan-templates,nutrition-library,nutrition-plan-templates}` |
| Themes | `/themes` (incl. public logo), `/system/themes` |
| Profile & team | `/me`, `/me/gym`, `/me/gyms`, `/me/link`, `/staff`, `/staff/link`, `/staff/:staffId/centers` |
| Members & memberships | `/members`, `/membership-plans`, `/user-memberships` (incl. `/:id/promotions`, `/:id/services`, `/member/:memberId/{configuration,billing-simulation}`), `/members/:memberId/{centers,professional-services}` |
| Catalogue | `/sellable-items`, `/taxes`, `/benefit-types`, `/charge-types`, `/professional-services`, `/result-types` |
| Promotions | `/promotions`, `/action-types` |
| Calendar & booking | `/calendar-events`, `/class-sessions`, `/activity-types` (incl. `/:activityTypeId/schedule-rules`), `/bookings`, `/recurring-bookings`, `/class-packages`, `/members/:memberId/{class-packages,personal-training-slots}` |
| Organization | `/centers`, `/spaces`, `/operating-hours`, `/trainers`, `/trainer-availability` |
| Training | `/muscles`, `/exercises`, `/workout-templates`, `/training-plan-templates`, `/training-plans`, `/shared-training-requests`, `/members/:memberId/{training-plans,member-training-plans,exercise-logs,workout-block-logs}` |
| Nutrition | `/nutrition-library`, `/nutrition-plan-templates`, `/member-nutrition-plans` |
| Billing & payments | `/billing` (nightly run), `/billing-events`, `/payments`, `/payment-requests`, `/payment-page`, `/payments/dashboard`, `/financials/dashboard` |
| System | `/audit-logs`, `/recycle-bin`, `/feature-flags`, `/storage`, `/system/website-integration` |
| Public & webhooks | `/public`, `/public/gyms/:gymRef/registrations`, `/webhooks/clerk`, `/webhooks/payment`, `/health`, `/docs` |

## Environment variables

Copy each `.env.example` to `.env` and fill in values. Do not commit `.env` files.

**API** (`api/.env`)

| Variable | Description |
|----------|-------------|
| `CORDEL_FITNESS_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Runtime DB connection (local: `localhost:3306` / `root` / — / `fitness`) |
| `DATABASE_URL` | MySQL connection string used by migrations (knex) |
| `PORT` | API port (default: `3000`) |
| `CORDEL_FITNESS_ADMIN_URL` / `CORDEL_FITNESS_MEMBERS_URL` | Public URLs of the admin and member apps |
| `CLERK_SECRET_KEY` | Clerk backend secret key |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Signing secret for `/webhooks/clerk` |
| `SEED_USER_ID` | Clerk user ID for the seed script (one-time use) |
| `PAYMENT_PROVIDER` | Payment adapter (default: `monei`) |
| `PAYMENT_ENV` | Optional label for the payment environment, reported in the payment-provider status |
| `PAYMENT_PAGE_URL` / `PAYMENT_OK_URL` / `PAYMENT_KO_URL` / `PAYMENT_NOTIFICATION_URL` | Hosted payment page, success/failure redirects and provider webhook URL |
| `MONEI_API_KEY` / `MONEI_WEBHOOK_SECRET` | MONEI credentials (required to create payment requests) |
| `MONEI_ACCOUNT_ID` | Optional — MONEI Connect sub-account |
| `BILLING_INTERNAL_SECRET` | Secret for `POST /billing/run` and `/billing/cleanup` (nightly `billing-run.yml`) |
| `RECURRING_BOOKINGS_INTERNAL_SECRET` | Secret for `POST /recurring-bookings/run` (nightly `recurring-booking-run.yml`) |
| `CLOUDFLARE_R2_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_BUCKET` | Optional — object storage for uploads and gym folders; unset disables storage features |
| `SUPPORTED_LOCALES` / `DEFAULT_LOCALE` | Optional — locales for translated DB content (defaults: `en,es,ca` / `en`) |
| `TRUST_PROXY_HOPS` | Optional — reverse-proxy hops in front of the API (default: `1`) |
| `PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR` / `PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY` | Optional — website self-registration rate limits (defaults: `60` / `200`) |
| `API_PUBLIC_URL` | Optional — public API origin shown on System → Website Integration |
| `LOG_LEVEL` | Optional — logger level (default: `info`) |

**Admin** (`apps/admin/.env`) / **Member** (`apps/member/.env`)

| Variable | Description |
|----------|-------------|
| `CORDEL_FITNESS_API_URL` | Backend base URL used by the `/api/proxy` route (local: `http://localhost:3000`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Sign-in path (e.g. `/en/sign-in`) |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` / `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | Admin only — post-auth redirects |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | Member only — post-sign-in redirect |
| `TENANT` | Admin only, optional — loads tenant-specific label overrides from `locales/tenants/<TENANT>/` |

# Gymdesk

Multi-tenant Gym Management SaaS. Express backend + Next.js frontend + MySQL 8 (Oracle HeatWave) + Clerk auth.

## Before implementing any feature

Read these two files first — they contain the full architecture map and step-by-step patterns:

- `docs/architecture.md` — codebase structure, auth, roles, DB conventions
- `docs/feature-patterns.md` — checklist and code templates for new features

Use **Members** as the reference implementation for staff-level CRUD with soft-delete.
Use **Plans** (`api/src/api/membership-plans.ts` + `apps/admin/src/app/[locale]/plans/`) as the reference implementation for admin-only CRUD.

Ticket order and current status live in `docs/roadmap.md`; full scope is in the GitHub issues.

## Hard constraints

- No microservices, no event sourcing, no AI/LLM integrations.
- One database: MySQL 8 (HeatWave when deployed). No additional stores without a concrete reason.
- Every domain table must have `gym_id`. Every query must filter by it.
- All config via environment variables. No hardcoded values.
- Backend-first: define the API contract before building UI.
- Do not duplicate business logic in the frontend.

## Local development

```bash
npm run db:up          # start MySQL 8 (docker compose)
npm run db:migrate     # run pending migrations
npm run dev:api        # Express on :3000
npm run dev:admin      # Next.js admin on :8081
npm run dev:member     # Next.js member app on :8082
```

Copy `.env.example` to `.env` in each app directory before starting.

## API tests

Run tests with `npm test` inside `api/`. All test files live under `api/src/test/`. Reuse the helpers in `helpers.ts` — `createTestGym`, `createTestMembership`, `request`, etc.

### Rules for every new test file

- One file per domain (e.g. `bookings.test.ts`, `members.test.ts`).
- Always call `cleanupTestGyms()` in `afterAll` and `db.end()` last.
- Always create a fresh gym + membership in `beforeAll` — never share state across `describe` blocks.
- Insert DB rows directly via `db.query` for setup; use the HTTP API (`request`) for the action under test.
- Do **not** add a `slug` column to `centers` — it does not exist in the schema.

### What to cover for every new router

1. **Tenant isolation** — a resource from gym A returns 404/403 when accessed with gym B's `x-gym-id`.
2. **Auth** — unauthenticated request returns 401; wrong role returns 403.
3. **Happy path** — the main success case returns the expected status and shape.
4. **Key invariants** — e.g. capacity/waitlist for bookings, 409/keep/expire for training plans, soft-delete hidden from list + restore for members.

### cleanupTestGyms dependency order

When adding a new domain that has FKs pointing to `members` or `gyms`, extend `cleanupTestGyms` in `helpers.ts` to delete those rows first. Current order: `bookings → members → class_sessions → activity_types → gyms`.

## Finishing a task

Always end by creating a pull request against `main`. Commit on a branch named `feat/<slug>-<issue-number>`, then open the PR with `gh pr create --base main`. Include the issue number in the PR title and body (`Closes #N`).

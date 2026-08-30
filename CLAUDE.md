# Gymdesk

Multi-tenant Gym Management SaaS. Express backend + Next.js frontend + MySQL 8 (Oracle HeatWave) + Clerk auth.

## Before implementing any feature

For any issue that involves new API surface, DB schema changes, or significant UI work, write a plan first and get approval before coding. A plan should cover: migrations, API endpoints, frontend sections, tests, and doc updates. Keep it concise — bullet points per layer, not prose.

Read these files first — they contain the full context needed to implement correctly:

- `docs/architecture.md` — starts with a TL;DR; full codebase structure, auth, roles, DB conventions below it
- `docs/feature-patterns.md` — step-by-step checklist and code templates for new features
- `docs/roadmap.md` — ticket order, current status, and phase decisions
- `docs/decisions.md` — settled architectural choices (MySQL, Clerk, no ORM, etc.) — don't re-litigate these

Use **Members** as the reference implementation for staff-level CRUD with soft-delete.
Use **Plans** (`api/src/api/membership-plans.ts` + `apps/admin/src/app/[locale]/plans/`) as the reference implementation for admin-only CRUD.

Use `/plan` to generate a structured implementation plan before coding. Use the `db-reviewer` agent to check migration files. Use the `test-writer` agent to generate test files.

## Parallel agents (worktree workflow)

Multiple Claude Code agents may work simultaneously, each in its own worktree and feature branch.

### Ground rules

- **One agent per worktree.** Never modify files in another agent's worktree directory.
- **One feature branch per task.** Always branch from `main`; never branch from another feature branch.
- **No destructive Git commands** (`git reset --hard`, `git clean -fd`, `git checkout -- .`, `git restore .`, `git branch -D`) unless the user explicitly requests them. Never discard changes to make a merge succeed.

### Required sync before feature completion

Before a feature is considered complete, the agent must integrate the latest `origin/main` into its branch:

```bash
git fetch origin
git merge origin/main   # always merge, never rebase
```

If conflicts occur:
- Resolve them carefully — preserve valid changes from **both** sides.
- Never blindly choose "ours" or "theirs".
- Pay particular attention to `docs/roadmap.md` (see below).
- Run tests after resolving conflicts.
- Confirm the working tree is clean before marking the feature done.

Use `/finish-feature` to run through the full sync + test + status checklist automatically.

### Special handling of docs/roadmap.md

`roadmap.md` is a shared file modified by multiple parallel agents.

- Keep changes minimal and focused on the current task.
- Do not reformat or reorder unrelated sections.
- Do not remove another agent's entries.
- When resolving merge conflicts in `roadmap.md`, keep changes from both sides — merge the sections manually rather than picking one side.
- Always sync with `origin/main` before the final commit if `roadmap.md` was modified.

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

### Unit tests vs integration tests

Write **unit tests** when the code under test has no DB or HTTP dependency — pure functions, middleware logic, crypto/validation helpers. No `createTestGym`, no `cleanupTestGyms`, no `db.end()`. Mock external dependencies with `vi.mock` or `vi.spyOn`.

Write **integration tests** for routers and anything that must exercise the full Express + MySQL stack. All rules below apply to integration tests only.

Good candidates for unit tests:
- Signature verification and payload parsing (e.g. `payments-provider.test.ts`)
- `requireModuleAccess` / `requireModuleWrite` permission matrix
- `tenantContext` and `centerContext` middleware
- Pure helper functions and input validation

### Rules for every new integration test file

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

Before opening the PR, run these checks in order:

1. **Migration review** — if any migration file was added or changed, run the `db-reviewer` agent on it. Fix all BLOCKERs before continuing.

2. **Test files** — for every new router, run the `test-writer` agent to generate `api/src/test/<router>.test.ts` (integration test). For any new pure functions or middleware, also write a unit test file (no DB helpers, use `vi.mock`/`vi.spyOn`). Run `npm test` inside `api/` to confirm all pass.

3. **Doc updates** — check whether the changes warrant updating any `.md` files:
   - `docs/roadmap.md` — mark the ticket done and update the Status section if the feature is complete.
   - `docs/architecture.md` — update if new tables, routers, middleware, or patterns were introduced.
   - `docs/feature-patterns.md` — update if a new pattern or template emerged that future tickets should follow.
   - `CLAUDE.md` — update if a new hard constraint, convention, or cleanup rule was established.

   Only update a file if the ticket genuinely changes what it documents. Navigation-only or i18n-only changes rarely need doc updates; new API surface, DB schema, or architectural patterns almost always do.

4. **Sync with origin/main** — run `/finish-feature` (or manually: `git fetch origin && git merge origin/main`). Resolve any conflicts carefully (see the Parallel agents section above). Re-run tests if any conflicts touched API code. The working tree must be clean before opening the PR.

5. **Open the PR** — commit doc changes together with the feature and run `gh pr create --base main` on a branch named `feat/<slug>-<issue-number>`. Include the issue number in the PR title and body (`Closes #N`).

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
Use **Plans** (`api/src/api/membership-plans.ts` + `apps/admin/src/app/[locale]/plans/`) as the reference implementation for an admin-only CRUD API and its Inline row CRUD frontend (expandable rows, no modals — see `docs/feature-patterns.md`). For the Modal CRUD frontend shape, see Class Types.

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
- A `weekday` column means **0=Sunday … 6=Saturday** (`gym_operating_hours`, `activity_type_schedule_rules`, `trainer_availability`, `training_plans`). A column storing luxon's ISO numbering (1=Monday … 7=Sunday) must be named `iso_weekday` instead, so the two bases can never be joined by accident — see `member_recurring_slots` (migration 169).
- A new `member_notifications.type` goes in **two** places: the `NotificationType` union in `api/src/infra/notifications.ts` **and** the `chk_member_notifications_type` CHECK (current definition: migration 170). Adding only the first makes every insert of that type fail invisibly — `sendNotification()` is fire-and-forget and only logs.
- A new `recordAudit({ entityType })` value also needs an `AUDIT_ENTITY_REGISTRY` entry in `api/src/infra/audit-registry.ts`. Without one the rows write but carry no `entity_name`, and the type never reaches the Audit Log's entity-type filter (`GET /audit-logs/meta`).
- Any new code path that inserts a `user_memberships` row must call `snapshotAssignedPlan()` (`api/src/api/assigned-plan-snapshot.ts`) inside the same transaction. An Assigned Plan owns the commercial configuration it was assigned with (#635 §11–§17) — an assignment created without one reads back as `snapshot_captured: false` and silently falls back to the live catalogue, so a Plan or Sellable Item edited later would move what it bills.
- Anything that removes a person's link to Gymdesk (a member, a staff login, a `gym_memberships` row) must decide the fate of their **Clerk account** through `api/src/infra/clerk-account-links.ts` (`classifyAccount` / `unlinkClerkAccount`): delete the Clerk user first when it was the last link, as `DELETE /members/:id` and staff `revokeAccess()` do. Otherwise the login is left orphaned — see "Orphaned Clerk accounts (#709)" in `docs/architecture.md`.
- Every Details view offers **View Audit Log** via the shared `apps/admin/src/components/ViewAuditLogButton.tsx` — never a hand-rolled deep link. Filter by the canonical entity type + id, never by display name. See "Details view → View Audit Log" in `docs/feature-patterns.md`.
- All config via environment variables. No hardcoded values.
- Translated **UI labels** live in `apps/*/locales/base/{en,es,ca}.json`. Translated **data** lives in a `(entity_id, locale)` junction table with the entity's own column as the base value and fallback — never one row per language, and never a `name_es`/`name_ca` column. Resolve it server-side from the request locale (`api/src/infra/locale.ts`) and return it in a separate field (`display_name`), leaving the base column for edit forms to submit back. See "Translated Catalog Content" in `docs/feature-patterns.md`.
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

When adding a new domain that has FKs pointing to `members` or `gyms`, extend `cleanupTestGyms` in `helpers.ts` to delete those rows first. Current order: `bookings → user_membership_services → members → class_sessions → activity_types → gym_charges → gyms`. A table whose FK to a catalog table (e.g. `gym_charges`) has no `ON DELETE CASCADE` must be deleted before that catalog table, not only before `members`.

## Finishing a task

Before opening the PR, run these checks in order:

1. **Migration review** — if any migration file was added or changed, run the `db-reviewer` agent on it. Fix all BLOCKERs before continuing.

2. **Test files** — for every new router, run the `test-writer` agent to generate `api/src/test/<router>.test.ts` (integration test). For any new pure functions or middleware, also write a unit test file (no DB helpers, use `vi.mock`/`vi.spyOn`). Run `npm test` inside `api/` to confirm all pass.

3. **Doc updates** — check whether the changes warrant updating any `.md` files:
   - `docs/roadmap.md` — mark the ticket done and update the Status section if the feature is complete.
   - `docs/architecture.md` — update if new tables, routers, middleware, or patterns were introduced.
   - `docs/feature-patterns.md` — update if a new pattern or template emerged that future tickets should follow.
   - `docs/go-to-production.md` — add a checklist item whenever the ticket defers something "until production" (there is no production environment yet); tick items the ticket completes.
   - `CLAUDE.md` — update if a new hard constraint, convention, or cleanup rule was established.

   Only update a file if the ticket genuinely changes what it documents. Navigation-only or i18n-only changes rarely need doc updates; new API surface, DB schema, or architectural patterns almost always do.

4. **Sync with origin/main** — run `/finish-feature` (or manually: `git fetch origin && git merge origin/main`). Resolve any conflicts carefully (see the Parallel agents section above). Re-run tests if any conflicts touched API code. The working tree must be clean before opening the PR.

5. **Open the PR** — commit doc changes together with the feature and run `gh pr create --base main` on a branch named `feat/<slug>-<issue-number>`. Include the issue number in the PR title and body (`Closes #N`).

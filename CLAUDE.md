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
- Any new code path that *edits* an existing assignment's snapshot must call `materialiseAssignedPlanSnapshot()` first, in the same transaction (#635 stage 6). The live fallback is all-or-nothing: the moment one section of an uncaptured assignment is written, the assignment counts as captured and every section the edit did not mention reads back as empty. An edit also stays on that assignment — never write through to the Membership Plan, another assignment or the Sellable Item — and a `cancelled`/`expired` assignment is not editable at all.
- Billing reads the **Assigned Plan snapshot**, never the live catalogue, for an assignment that already exists (#635 §13–§17). A query that projects, charges or advances an assignment's billing takes its cadence from `ASSIGNMENT_CADENCE` in `api/src/api/assigned-plan-snapshot.ts` (`COALESCE(um.recurring_billing_*, bp.recurring_billing_*)`) and therefore **LEFT** JOINs `billing_policies` — an INNER JOIN drops every assignment whose Plan lost its policy. Prices and benefits come from `user_memberships.membership_fee_price`, the `user_membership_{session,oneoff,periodical}` rows, the `user_membership_promotion_*_snapshot` rows and `user_membership_services`' own price columns; the live catalogue is only the fallback for an assignment that captured no snapshot.
- A code path that prices an assignment's **Membership Fee** on a given date applies the assignment's own Billing & Duration through `classifyPlanDurationPeriod()` (`api/src/domain/planDuration.ts`): the Free Period and the Bonus Duration waive the fee, counted from the assignment's `starts_at` — never snapped to the first of its month, which is a Promotion preview's anchor, not a real contract's (#635 §7, stage 8). **An applied Promotion outranks it**: where a Promotion governs the date (inside its own timeline, or applying its Membership Fee Benefit) it decides the fee alone, per the #635 thread's Q2 answer — stacking the two also lets the Plan's free month override a Promotion's paid one, which inverts that answer. The durations come from `user_memberships.free_months`/`paid_months`/`bonus_months` and fall back to the Plan's live columns only for an assignment that captured no snapshot at all; a per-column `COALESCE` is wrong here, because the columns are nullable and a Free Period added to the Plan later would reach assignments that already exist (§13). Only the Membership Fee is waived — a Plan's Period Benefits are still charged in a free month.
- Any new code path that prices, or displays, a Promotion **already applied** to a `user_memberships` row reads that application's own snapshot — `membershipFeeBenefitsFromSnapshot(ump.snapshot)` for the Membership Fee Benefit, the `user_membership_promotion_*_snapshot` rows (via `loadPromotionGrantSnapshots()`) for the granted Sellable Items — never a live join against `promotion_membership_fee_benefits` or `promotion_{session,oneoff,periodical}` (#635 §16, stage 7). `final_price` is recomputed at every apply/revoke, so a live read lets a Promotion edited in between reprice every assignment that already carries it. The live tables are the fallback for one case only: an application whose `snapshot` is NULL (applied before migration 149), which has nothing else to read.
- Any new code path that applies a Promotion to a `user_memberships` row must honour `promotions.only_applicable_for_new_members` via `isNewMember()` (`api/src/api/new-member-eligibility.ts`), passing the assignment being configured as the excluded one — it must never disqualify its own Member. The column is `NOT NULL DEFAULT 1`, so every Promotion carries the flag unless someone cleared it: a path that skips the check hands new-member Promotions to members who never left (#634 §3).
- A `user_membership_promotions` row is one **application** of a Promotion, and an assignment may hold several of the same Promotion over time (#635 stage 9, migration 183): only one of them may be *standing*, which `ump_one_standing_per_promotion` (the `standing_promotion_key` generated column, non-NULL while `status = 'applied'`) enforces. Revoking is therefore reversible — a code path that re-applies inserts a **new** row with its own snapshot of the Promotion as it stands now, and never resurrects the revoked one: that row's snapshot is what it was agreed with (§16) and its `[applied_at, revoked_at]` window is what tags the Billing Events ledger, so rewriting either falsifies what the member was already billed. Anything that asks "is this Promotion on this assignment?" filters `status = 'applied'`, and anything keyed per application (a React list key, a snapshot table's FK, a grants map) keys on `user_membership_promotions.id`, never on `(user_membership_id, promotion_id)`.
- Anything that removes a person's link to Gymdesk (a member, a staff login, a `gym_memberships` row) must decide the fate of their **Clerk account** through `api/src/infra/clerk-account-links.ts` (`classifyAccount` / `unlinkClerkAccount`): delete the Clerk user first when it was the last link, as `DELETE /members/:id` and staff `revokeAccess()` do. Otherwise the login is left orphaned — see "Orphaned Clerk accounts (#709)" in `docs/architecture.md`.
- Which activities a member may book is configured on the **Activity Type**, never on the Membership Plan: `activity_type_eligible_plans` (#481) names the plans allowed to book a non-`public_event` activity, and `api/src/api/activity-eligibility.ts` is the only plan-based booking gate (it also claims a class-package credit for a member whose plan does not cover the activity). The Plan-side copy of that relation, `plan_allowances` ("Included Services"), was retired by migration 177 (#635 §1) — do not reintroduce a per-plan activity grant or a per-window session cap.
- A Promotion's **Membership Fee Benefit** is one row in `promotion_membership_fee_benefits` (#635 §5, migration 179), keyed to the Promotion alone — it has no Sellable Item and no `charge_type_id`, because the item is always the membership fee. It is the only Promotion benefit that changes what the membership fee bills, and `computeFinalPrice()` applies exactly one per applied Promotion. The `charge_types`-keyed tables it replaced (`promotion_charge_benefits`, `promotion_period_benefits`, `promotion_included_benefits`) are dropped: **Charge Benefits no longer exist anywhere** — not on a Plan (migration 176), not on a Promotion. Do not reintroduce a benefit that waives or discounts a Sellable Item; a Promotion's other benefits are the Sellable-Item-keyed `promotion_{session,oneoff,periodical}` grants.
- A **Custom Theme logo** is an object in the gym's own Cloudflare folder, never bytes in the database: `POST /system/themes/:id/logo` is the only writer of `themes.logo_object_key`, and the key is always `<gyms.storage_folder_prefix>/Branding/Logo/logo.<ext>` from `buildGymLogoKey()` — the extension comes from the server-validated MIME type, never from the uploaded file name, and `CHECK chk_themes_logo_storage` (migration 180) forbids a row carrying both a key and a `logo_bytes` blob. That key names the *gym*, so it is one branding logo per gym: an upload hands the slot over inside one transaction (the uploading theme takes the key, every other theme of the gym stops claiming a logo) and deletes the object it replaced. Do not add a second logo store, a theme-scoped key, or a stored logo URL — the URL is derived from the key by `themeLogoUrl()` (`api/src/domain/themeLogo.ts`) and returned as `logo_url`; a Base Theme logo stays a blob, since the platform has no gym folder to upload into.
- A Theme's **Members App background images** are six fixed slots (`training`, `nutrition`, `calendar`, `bookings`, `background`, `membership`), one `theme_member_images` row per configured slot (migration 181), each holding the R2 object key `<prefix>/Themes/<theme_id>-<sanitized theme name>/Members/<slot>.png` from `buildThemeMemberImageKey()` — the uploaded file's name and type never reach the key, and the `.png` in it is the slot's name, not a claim about the bytes (the object's validated `Content-Type` is). The prefix is the gym's `storage_folder_prefix` for a Custom Theme and `PLATFORM_STORAGE_ROOT` (`cordel`, the sibling of the `gyms/` root) for a **Base Theme**, whose rows carry `gym_id IS NULL` (#732, migration 182) and are written only by `POST`/`DELETE /platform/themes/:id/members-images/:slot` — never by the gym-scoped routes, and each router answers 404 for the other's themes. A gym *reads* a Base Theme's slots (that is how its members see them), so the tenant-scoped loader takes `gym_id IS NULL` rows only for theme ids the caller already named: never relax that filter further, add a second platform root, or copy a platform object into a gym's folder. The gym's own folder tree is `GYM_FOLDERS` in `api/src/infra/storage.ts` and nothing else: Gym Bucket Initialization writes the gym-level `Themes/` root (#735) and must never create a theme's own `Themes/<theme_id>-<name>/Members/` branch, which cannot exist before the theme does and is written by `ensureStorageFolders()` at upload time. Add a new top-level folder by appending to that list — never in the middle, so existing folders keep the order they were written in — and spell `Themes` only as `THEMES_FOLDER` (re-exported as `THEME_STORAGE_FOLDER`). **The row, not the object, is what makes a slot configured**: `DELETE /system/themes/:id/members-images/:slot` deletes the row and deliberately leaves the object in the bucket (#725), so a re-upload reuses the same key. Do not add a second slot, a per-slot column on `themes`, a stored URL (it is derived by `memberImageUrls()`), or a fallback to another theme or asset source — a `null` slot means the theme background colour and nothing else. Validate an upload by image **signature**, never by the `Content-Type` header. A new slot goes in **two** places: `MEMBER_IMAGE_SLOTS` in `api/src/domain/themeMemberImages.ts` **and** the `chk_theme_member_images_slot` CHECK (current definition: migration 181) — adding only the first uploads the object to R2 and *then* fails the insert, leaving an orphan and a 500. On the member side those slots are painted in exactly two places — `MembersBackground` for the page and `MembersSectionCard` for a section surface (#728), both off `theme.members_images` and the helpers in `apps/member/src/lib/membersBackground.ts`. A surface that wants its section's artwork wraps itself in that card rather than writing a second background rule, and it never fetches, never resolves a key and never substitutes another slot's image for a `null` one.
- Any new code path that creates a Customer Theme (a `themes` row with a non-null `gym_id`) must capture the `created_by_name`/`created_by_type` actor snapshot in the same INSERT — today only `POST /system/themes/clone/:sourceId` does (#712, migration 178). The columns are nullable and written once, so a path that skips them leaves that Theme with no creator forever, and the Custom Themes header renders `—`.
- A list page's **filter bar** is `FilterBar`/`FilterField` (+ `filterControlStyle`) and its **header band, surface, cell insets and row dividers** are `listChrome.ts` — the same constants `DataTable` is built from (#724). Never restate a header background, a control height or a row divider in a page, and never hand-roll a second filter-bar look: a card list and a table list have to stay the same screen. Header cells and row cells share one `LIST_COLUMNS`-derived grid inside one `overflow-x: auto` wrapper (#637). See "Filter bar and list header" in `docs/feature-patterns.md`.
- Every Details view offers **View Audit Log** via the shared `apps/admin/src/components/ViewAuditLogButton.tsx` — never a hand-rolled deep link. Filter by the canonical entity type + id, never by display name. See "Details view → View Audit Log" in `docs/feature-patterns.md`.
- A gym-facing read of a **platform catalogue** (the `gym_id IS NULL` rows of a shared table) goes on the gym's own router behind `tenantContext` — never on `/platform/*`, which is `requireSuperadmin` and would lock out the gym admin who needs it (`GET /exercises/base`, #718). When a gym copies such a row into its own catalogue, the copy records provenance in **`cloned_from_id`**, and that column is the only source of truth for "where did this come from": `POST /exercises/import` reads it to decide what the gym already has, and the Exercises list derives its **System sourced** / **Custom** badge from it. Do not add a source/origin column or duplicate the library row's identity anywhere else.
- All config via environment variables. No hardcoded values. Payment provider credentials in particular stay in the environment — the `payment_providers` catalogue (#636) names *which* adapter a gym uses (`provider_key`), never how to authenticate as it.
- Every new code path that inserts into `gyms` must set `payment_provider_id` (NOT NULL since migration 175). Take the catalogue's default (`is_default = 1 AND deleted_at IS NULL`) unless the caller names one — `api/src/api/gyms.ts`, `api/src/test/helpers.ts` and `api/src/infra/seed.ts` are the three existing paths.
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

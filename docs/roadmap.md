# Gymdesk Roadmap

Phased implementation roadmap derived from the target ER model, adapted to the existing
multi-tenant architecture (every table gets `gym_id`; the diagram's monolithic `User` maps
onto the existing `members` + `gym_memberships` split — no new users table).

Each ticket below is a GitHub issue in `cordel-app/gymdesk`. Full scope and acceptance
criteria live in the issue bodies; this doc is the map.

Engineering quality backlog (tests, typing, helpers, member-app gap analysis) lives in
`docs/tech-debt.md` as a **map** of GitHub issues (#81–#86) — same model as this roadmap.
Agent session prompts: `docs/agent-prompts.md`. Always implement via the GitHub issue body.

## Status (2026-07-19)

- **Done**: Phase M (#45–#49, MySQL cutover 2026-07-04), P0.1–P0.3, P1.1–P1.8, P2.1–P2.8, P3.1–P3.4, P4.1–P4.5, P5.1–P5.6, P6.1–P6.3, #114, #117, #120, #121, #123, #124, #127, #129, #131, #132, #135.
- **Training module redesign (#60–#63, done)**: dynamic Workout Block form driven by
  `blockFieldConfig.ts` (#60); tree-grid Training Plan Template editor (#61); dependency
  awareness for shared catalog entities (#62); tree-grid Workout Template editor with
  in-place block/exercise CRUD, paginated/filtered list (`created_by_membership_id`,
  migration 053) and cross-template block drag-and-drop via `PUT …/blocks/:id/move` (#63).
  Patterns documented in `docs/feature-patterns.md` (Tree-Grid Editor, Config-Driven Fields,
  Dependency Awareness).
- **Personalized Training Plans module (#67, done)**: gym-level **Training → Training
  Plans** page (list, filters by member, source template, status, created by, and date
  ranges) with a two-step "New Training Plan" dialog (From Template / From Scratch) that
  posts to `POST /training-plans`. Existing-active-plan collisions return `409`; the UI
  swaps to a keep-vs-expire prompt whose "Expire" branch closes prior actives
  (`status='expired'`, `end_date` = new plan's start) and their `member_training_plans`
  rows atomically before the new plan is created. Editor page at
  `/training-plans/[id]` with a header form (name/desc/dates/status), drag-reorder for
  workouts, cross-parent move + duplicate for blocks and exercises via new endpoints on
  `training-plans.ts` (`…/blocks/:id/move`, `…/exercises/:id/move`,
  `…/duplicate` at each level). Templates page gains an **Assign Plan to Member** action
  on active templates that opens the same dialog with the template preselected.
  Migration 054 adds `training_plans.start_date` (backfilled from the latest
  `member_training_plans.valid_from`) and `end_date`, and updates the status CHECK to
  `draft/active/expired/deleted` (existing `inactive` rows remapped to `expired`).
  `training-plan-creation.ts` extracts the clone/write-history transaction so both
  `POST /training-plans` and the legacy `POST /members/:id/member-training-plans` share
  one implementation.
- **Training Plans UX Redesign — Inline Editing (#112, done)**: replaced the
  `/training-plans/[id]` editor page with an inline expandable card list matching the
  Training Plan Templates UX. Each card expands to show workouts/blocks/exercises with
  the existing drag-reorder and block/exercise CRUD modals. New context menu actions:
  **Edit** (inline metadata), **Details** (read-only modal with full audit info),
  **Duplicate** (clones the full plan tree to a draft), and **Complete** (transitions
  status to `completed`, stamps `end_date`, makes plan read-only). Migration 066 adds
  `completed` to the status CHECK constraint. The old `/training-plans/[id]` route now
  redirects to the list. All write endpoints on `training-plans.ts` reject completed plans
  with 403.
- **Billing ledger member history endpoint (#114, done)**: `GET /billing-events/member/:memberId`
  convenience alias added to `billing-events.ts` (paginated, tenant-isolated, 404 on unknown
  member). First test suite for the billing ledger (`billing-events.test.ts`): 14 tests
  covering auth, happy paths, new endpoint, and cross-gym tenant isolation.
- **Cordel platform menu + two-scope audit log (#66, done)**: superadmin-only **Cordel**
  sidebar group (Gyms, Users, platform Audit Log at `/cordel/audit`); **System** reduced to
  gym-scoped Audit Log + Customize and opened to gym admins (`requiredRole: 'admin'`).
  `GET /audit-logs?scope=all` (platform superadmins only, `tenantCtx.isSuperadmin`) lifts
  the tenant gym filter and joins `gyms.name`; shared `AuditLogView` component renders both
  scopes, adding a Gym column in platform mode.
- **Audit Log UX Improvements (#69, done)**: each audit row is now a self-contained
  historical snapshot. `actor_name` and `entity_name` are captured at write time and never
  recalculated (migration 055; existing rows truncated). Actor name comes from the Clerk user
  object already fetched in `tenantContext` (zero extra queries). Entity name is resolved by
  `infra/audit-registry.ts`: named entities use a `name`-column lookup; M-N/link entities
  get a composed label from their FK parents (e.g. `user_membership` → member name + plan
  name). FK fields in `previous_values`/`new_values` are enriched at write time from plain
  `foo_id: value` to `foo: { id, name }` objects. `GET /audit-logs/meta` returns the full
  entity-type list + action list for dropdown population. New filter params: `entity_name`
  (LIKE), `actor` (name LIKE or Clerk ID exact match), `action`, `source`. `AuditLogView`
  gains dropdowns for entity type, action and source; actor now searched by stored name;
  entity column shows `type#id` + name beneath it; Clerk uid surfaced only in the expanded
  row. `class-types.ts` and `promotions.ts` gain `recordAudit` coverage.
- **Done outside the phase plan**:
  - **Per-gym theming (#51, extended by #68)**: `gyms.theme_key` (migration 030, presets `indigo/emerald/crimson/amber`), `ThemeProvider`, and the superadmin **System → Customize** editor (now replaced by #68).
  - **Centers UI Redesign (#74)**: Centers list now shows Email, truncated Address, Active Members count, and a ContextMenu (⋮) replacing Edit/Delete buttons. Menu items: Edit (existing modal, unchanged), Details (new read-only dialog with General / Statistics / Audit sections including `created_by`/`modified_by`/`deleted_by` resolved names), View Members (navigates to `/members?centerId=X&status=active`), Delete. Migration 064 adds `created_by_membership_id` and `deleted_by_membership_id` to `centers`. `GET /centers` and `GET /centers/:id` return `active_member_count` (subquery) and resolved modifier names via LEFT JOINs. `GET /members` gains `?centerId` filter. Members page reads `centerId` from URL params on load and shows a center dropdown filter (multi-center gyms only). `ContextMenu` component updated to `position: fixed` dropdown so it escapes `overflow: hidden` table containers.
  - **Membership Plans Redesign (#70)**: `membership_plans` gains `lifecycle_status` ENUM(`draft`/`active`/`archived`) + `enrollment_status` ENUM(`open`/`closed`) + soft-delete + audit fields (migrations 058–062). `class_types` renamed to `activity_types` (migration 059, all FK references migrated). New tables: `billing_policies` (1-per-plan billing/service cycle config), `plan_allowances` (replaces `class_type_user_memberships` + `membership_plan_benefits`; supports `unlimited` and `session_count` with recurrence), `membership_plan_centers` (optional per-plan center restriction). API: enriched `GET /membership-plans` (nested `billing_policy`, `allowances`, `centers`, `price_history`, `current_price`, `member_count`); new actions `duplicate`, `archive`, `PUT enrollment`. Booking enforcement (`plan-allowances.ts` side-effect hook) checks center restriction then allowance type/quota. Admin UI replaces DataTable with a per-plan accordion showing all five sections inline; context menu with Edit / Duplicate / Open‑Close Enrollment / Archive / Delete.
  - **Theme Management (#68)**: first-class `themes` entity (migrations 056–057 — table + gym FK). `tokens` JSON carries header/sidebar/typography design tokens. Superadmin **Cordel → Themes** CRUD (draft/active/deleted lifecycle, logo upload up to 512 KB via `POST /platform/themes/:id/logo`, `GET /themes/:id/logo` public caching endpoint). Gyms assigned a theme via `theme_id` FK replacing old `theme_key`. Admin `ThemeProvider` reads `activeGym.theme.tokens` from the gym list response (LEFT JOIN) and writes `--gd-*` CSS variables live on gym switch. Member app introduces `GET /me/gym` (no tenant context needed) so `AppContext` self-resolves gymId + theme; member-side `ThemeProvider` applies the same variables. Both `TopHeader` and `Sidebar` consume `--gd-*` vars; `BottomNav` in the member app follows suit.
  - **Immediate Theme Application on Default Change (#143)**: After a successful `PUT /system/themes/:id/set-default`, the Themes page now calls `refreshGyms()` in parallel with `loadAssignments()`. `GymProvider` re-fetches the gym list (which includes the updated `theme.tokens`), causing `ThemeProvider` to re-apply `--gd-*` CSS variables immediately — no browser refresh required. No backend or migration changes.
  - **Theme Assignment Management (#120)**: Gym admins can now assign themes to the Organization and individual Centers from within the inline Theme editor. System → Themes page (`/themes`) rebuilt as the proper gym-admin page using `GET /system/themes` (was accidentally overwritten in #117 with Base Themes content). New Assignments tab in the inline editor for every theme (base or custom): org-default checkbox (`gyms.theme_id`), center list with Inherited/Assigned badges, Restore Inheritance (sets `centers.theme_id = NULL`), "+ Assign Centers…" multi-select picker, search filter, show-all when > 10. Five new endpoints on `gym-themes.ts`: `GET/:id/assignments`, `PUT/:id/set-default`, `GET/:id/unassigned-centers`, `POST/:id/assign-centers`, `DELETE/:id/centers/:centerId`. Delete guard unified to single message: "This theme is currently in use. Remove all assignments before deleting it." Theme resolution order: `centers.theme_id` → `gyms.theme_id` → first alphabetically.
  - **Base Themes rich list (#121)**: Cordel → Base Themes page gains a rich summary row: Logo (32×32), Name, Description (first line truncated), Type badges (System/Custom + Default when `gyms.theme_id` points to the theme), Usage count (distinct orgs for system themes; centers direct or inherited for custom themes), and Status. The ⋮ context menu now includes a Details action opening a read-only modal with full description, type, status, usage, owner (Cordel / gym name), org-default flag, and audit fields (Created/Modified by + at, resolved from `audit_logs`). New `description TEXT` column added to `themes` (migration 068). `GET /platform/themes` now returns all themes (system + custom) in one list; `GET /platform/themes/:id` includes `created_by_name` / `modified_by_name`.
  - **Nutrition Plan Templates (#132)**: Inline expandable nutrition module. Shared gym-scoped catalogs: `dishes`, `sides`, `sauces` (each a full CRUD router: `GET/POST/PUT/DELETE /dishes|sides|sauces`; `DELETE /dishes/:id` returns 409 if the dish is referenced in any template). Template hierarchy: `nutrition_plan_templates` → days (weekday 0–6, one per weekday per template) → meals (N per day, drag-reorder) → meal_dishes (N per meal, each with optional side + sauce, drag-reorder). New routers: `nutrition-plan-templates.ts` (template CRUD + duplicate deep-clone + hierarchy endpoint + day/meal/meal-dish CRUD + per-level reorder), `meals-catalog.ts` (factory for dishes/sides/sauces). Admin UI: **Nutrition → Meals** page (three expandable catalog sections), **Nutrition → Nutrition Plan Templates** page (expandable cards with inline tree editor using @dnd-kit at three levels). Migration 071 creates 7 new tables. 38 new tests; `cleanupTestGyms` extended with nutrition table deletions.
  - **Centers UX Redesign (#131)**: Centers page replaces the DataTable + modal editor with the standard Cordel inline expandable row pattern. Collapsed row shows Name, Email, Theme (with "(Inherited)" suffix when `center.theme_id` is null), Status inline dropdown, Created At, and a ContextMenu (Details / Delete). Expanding a row opens four inline sections: General Information (Name, Code, Status), Contact Information (Email, Phone), Location (Address), and Theme assignment. All text fields auto-save on blur/Enter; dropdowns (Status, Theme) auto-save on change. No Save/Cancel buttons. "+ Add Center" creates a record via POST then auto-expands + focuses the Name field. Theme section: dropdown of all gym-accessible themes (base + custom); when a direct theme is assigned, a "Restore inheritance" link appears to reset `center.theme_id` to null. Details modal (audit only: Created At/By, Modified At/By, Deleted At/By). The legacy "Edit Center" modal is removed. `GET /centers` and `GET /centers/:id` now join `themes` and `gyms` to return `theme_name` and `gym_theme_name`.
  - **Workout Templates Fully Inline Editing (#130)**: Replaces modal-based block/exercise editing with always-editable inline fields — no save/cancel buttons, no modals. Block header is a single row (name input + type select + rounds input) that auto-saves on blur/change. Exercise table rows are always editable; exercise selection uses a custom filter-as-you-type combobox (position: absolute listbox, closes on outside click). Type-adaptive columns: `reps` → Sets/Min–Max reps/Rest, `time` → Sets/Duration/Rest, `distance` → Distance/Unit/Rest. Rest field displayed in minutes (÷60 display, ×60 on save). New endpoints: `POST /:id/blocks/:blockId/duplicate` (deep-copies block + exercises), `POST /:id/blocks/:blockId/exercises/:exId/duplicate`. Context menus: Duplicate + Delete (no Edit). `BlockModal` and `ExerciseModal` removed. Migration 071 adds `exercise_type VARCHAR(20) NOT NULL DEFAULT 'reps'` (CHECK: reps/time/distance) to `exercises`; adds `duration_seconds INT UNSIGNED`, `distance_value DECIMAL(8,2) UNSIGNED`, `distance_unit VARCHAR(20)` to `workout_template_exercises`. `exerciseSummary()` in `summaries.ts` updated for type adaptation and rest-in-minutes.
  - **Promotions UX redesign (#127)**: Promotions page replaces the DataTable + modal editor with the standard inline expandable row pattern. Collapsed row shows Name, Description, Created, Start Date, End Date, Status badge, and a ContextMenu (Details / Duplicate / Delete). Expanding a row opens an inline form for all promotion fields plus two embedded child collections: **Charge Benefits** (charge_type, action, value) and **Period Benefits** (membership_plan, action, value, duration_months). Both collections display as compact tables with inline add-row forms and per-row delete. "+ New Promotion" creates a record and auto-expands + focuses the Name field. Search by name/description with 300ms debounce; status filter; `created_by_membership_id` tracking (migration 069). `promotion_period_benefits` table redesigned from "pay X get Y free" model to "plan + action + value + duration" model (migration 070). New API: `GET /promotions` adds `q`, `created_by`, `sort`, `dir`; `GET /promotions/created-by-options`; `POST /promotions/:id/duplicate` (deep-copies charge + period benefits); `PUT /charge-benefits/:cbId`; `PUT /period-benefits/:pbId`; `POST /period-benefits` updated to new shape. Details modal simplified to audit info only (created_by, created_at).
  - **Base Themes UX unification (#117)**: Cordel → Base Themes page replaces the DataTable + modal editor with the same inline expandable row pattern used by System → Themes. Each row shows a color swatch, name, status badge, and a context menu (Clone, Details, Delete). Expanding a row opens the branding/typography/colors inline editor. New `POST /platform/themes/clone/:id` clones a base theme into a new base theme (superadmin only). A read-only Details modal surfaces name, created_at, and modified_at. Deleted themes are non-expandable.
  - **Theme Management v2 (#97)**: Separates platform-owned Base Themes from customer-owned Customer Themes. Migration 065 adds `gym_id` to `themes` (NULL = base, non-NULL = customer theme for that gym) and `theme_id` to `centers` (optional per-center override). Seeds "Black" base theme. New `POST /system/themes/clone/:id` (clone any theme to customer theme), `PUT/DELETE /system/themes/:id` (edit/soft-delete customer themes with gym/center conflict guard), logo endpoints. Cordel nav entry renamed to **Base Themes** (`nav.base_themes`); new **System → Themes** page (`/themes`) for gym admins shows System Themes (read-only, expandable) and My Themes (inline editable with ContextMenu: Clone / Activate / Edit / Delete) in separate sections.
  - **Team management (#53)**: gym-scoped admin/coach/staff CRUD via `gym-users.ts` + the **Organization → Team** page. Clerk-invitation flow with an `invited` placeholder row that links on first sign-in; self-edit and last-admin guards; audited. Added `gym_memberships` columns `status`, `email`, `name`, `invitation_id` (migrations 031–034).
  - **Platform superadmin management**: `platform/superadmins` + **System → Users**.
  - **Grouped, role-gated sidebar**: `config/navigationGroups.ts` (Membership / Organization / Training / Nutrition / Financials / System / Cordel).
  - **Staff nav rename (#77)**: Navigation-only refactor. **Team** entry renamed to **Staff** and now points to the existing Trainers page (`/trainers`). The standalone **Trainers** nav entry removed. `trainers.title` i18n key updated to "Staff" across `en`/`es`/`ca` locales. No API, DB, or business logic changes.
- **Placeholder shells (built, content pending)**: per-group Dashboard pages (`organization`, `training`, `nutrition`, `financials`, singular `membership`). Nutrition has no backend yet.
- **Phase 9 — Centers (#59, supersedes Phase 7)**: `Center` (migration 043) as the single
  location concept going forward — `gym_locations` was never built. `member_centers`
  junction (044) gives each Member one or more Centers with a default; `center_id` +
  audit-column backfill added to `rooms`/`class_sessions`/`bookings` (045–047); every
  existing Gym auto-got one default Center named after the gym, every existing Member
  defaulted onto it (046), and new gyms get the same default Center at creation. New
  `resources`/`trainer_availability`/`events` tables (048–050), each `center_id`-scoped
  from creation. `centerContext` middleware (`x-center-id` header) mirrors `tenantContext`;
  `resolveCenterId()` falls back to a gym's sole active Center so single-center gyms need
  no UI changes. Admin: **Organization → Centers/Resources/Events** pages, Trainer
  Availability inline on the Trainers page, Member-edit Assigned Centers/Default Center
  (hidden until a gym has >1 center). Member app: `GET /me/centers` + an optional
  center switcher, hidden for the single-center case. **Phase 7 (#39–#41) is superseded
  and closed** — its `gym_locations`/nullable-FK design was never implemented.
- **Deferred**: Phase 8 (Stripe payments).
- Platform naming migrated gymdesk → fitness (2026-07-10/11): DB schema `fitness`, containers/images
  `fitness-*`, VPS user `podman`, env vars `CORDEL_FITNESS_*`. See `docs/architecture.md` § Deployment.
- Legacy cleanup complete: `/fares` and `/subscriptions` routers + the old
  Subscriptions page deleted, `user_memberships.plan` column dropped
  (migrations 004, 007, 009). The member app's `/subscriptions` route was
  renamed to `/membership` (P1.8).

## Decisions

- **Database (updated 2026-07-03)**: migrate from Neon PostgreSQL to **Oracle HeatWave MySQL**
  (paid tier, ~€50/mo) for predictable pricing and single-vendor infra. Tracked as
  **Phase M ([#45](https://github.com/cordel-app/gymdesk/issues/45)–[#49](https://github.com/cordel-app/gymdesk/issues/49))**, which **blocks Phase 1**. MySQL consequences for later tickets:
  partial unique indexes (P1.5, P2.5) become generated column + unique index; `jsonb`/`inet`
  (P6.1) become `JSON`/`VARCHAR(45)`; `RETURNING` is replaced by insert + select helpers.
- **Multi-location (updated 2026-07-15)**: shipped as **Phase 9 — Centers (#59)**, superseding
  the deferred Phase 7 `gym_locations` design (never built). `Center` is the single location
  concept; `Gym` remains the tenant boundary.
- **Payments**: internal `billing_events` ledger first (staff-recorded); Stripe is Phase 8.
- `fares` → `membership_plans` and `subscriptions` → `user_memberships` **evolve in place**
  with data-carrying migrations; old routes/pages are replaced.
- Trainers are existing `coach`-role rows in `gym_memberships`; trainer data (specialities)
  attaches there.
- Lookup vocabularies (`benefit_types`, `charge_types`, `action_types`) are global tables
  (no `gym_id`), seeded in their migrations. Statuses are `text` + CHECK constraints.
- Exercises/muscles catalog is **per-gym**, with an idempotent `import-defaults` seed endpoint.
- "Replaces" tickets keep the old route mounted until the phase's frontend ticket lands,
  then delete it.

## Conventions

Every feature ticket follows `docs/feature-patterns.md`: migration → Express router
(`requireRole` guards, `gym_id` filter, `ER_DUP_ENTRY`→409) → register in `api/src/index.ts` →
admin page (Members page as staff-level/soft-delete template, Plans page as admin-only
template) → Sidebar → i18n (en/es/ca).

## Phases

### Phase M — MySQL migration (blocks Phase 1)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| M1 Provision HeatWave MySQL on OCI (backups + PITR) | [#45](https://github.com/cordel-app/gymdesk/issues/45) | S | — |
| M2 Replace node-pg-migrate with Knex targeting MySQL | [#46](https://github.com/cordel-app/gymdesk/issues/46) | M | — |
| M3 Port backend data layer and queries to mysql2 | [#47](https://github.com/cordel-app/gymdesk/issues/47) | L | #46 |
| M4 Migrate data from Neon to HeatWave | [#48](https://github.com/cordel-app/gymdesk/issues/48) | M | #45 #47 |
| M5 Cutover deploy, CI on MySQL, roadmap amendments | [#49](https://github.com/cordel-app/gymdesk/issues/49) | M | #48 |

### Phase 0 — Foundation
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P0.1 Extract shared DataTable, CrudModal, ConfirmDialog | [#2](https://github.com/cordel-app/gymdesk/issues/2) | M | — |
| P0.2 StatusBadge + status-filter convention | [#3](https://github.com/cordel-app/gymdesk/issues/3) | S | #2 |
| P0.3 Member app navigation shell | [#4](https://github.com/cordel-app/gymdesk/issues/4) | M | — |

### Phase 1 — Membership plans & billing core (replaces fares, subscriptions)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P1.1 ⚠️ Migrate fares → membership_plans | [#5](https://github.com/cordel-app/gymdesk/issues/5) | M | — |
| P1.2 Replace Fares page with Plans page | [#6](https://github.com/cordel-app/gymdesk/issues/6) | M | #5 #2 #3 |
| P1.3 membership_plan_prices with validity windows | [#7](https://github.com/cordel-app/gymdesk/issues/7) | M | #6 |
| P1.4 benefit_types + membership_plan_benefits | [#8](https://github.com/cordel-app/gymdesk/issues/8) | M | #7 |
| P1.5 ⚠️ Migrate subscriptions → user_memberships | [#9](https://github.com/cordel-app/gymdesk/issues/9) | L | #5 |
| P1.6 charge_types + billing_events ledger | [#10](https://github.com/cordel-app/gymdesk/issues/10) | M | #9 |
| P1.7 Replace Subscriptions page with Memberships page | [#11](https://github.com/cordel-app/gymdesk/issues/11) | L | #9 #10 #2 |
| P1.8 Member app: my membership + payment history | [#12](https://github.com/cordel-app/gymdesk/issues/12) | M | #11 #4 |

### Phase 2 — Classes v2 (replaces classes, bookings v1)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P2.1 Rooms CRUD | [#13](https://github.com/cordel-app/gymdesk/issues/13) | S | #2 |
| P2.2 Specialities + trainer_specialities | [#14](https://github.com/cordel-app/gymdesk/issues/14) | M | #13 |
| P2.3 class_types CRUD | [#15](https://github.com/cordel-app/gymdesk/issues/15) | M | #14 |
| P2.4 ⚠️ Migrate classes → class_sessions | [#16](https://github.com/cordel-app/gymdesk/issues/16) | L | #15 |
| P2.5 ⚠️ Bookings v2: waitlist, capacity, attendance | [#17](https://github.com/cordel-app/gymdesk/issues/17) | L | #16 |
| P2.6 Replace Classes/Bookings pages with Schedule | [#18](https://github.com/cordel-app/gymdesk/issues/18) | L | #17 #2 |
| P2.7 class_type_user_memberships plan-access control | [#19](https://github.com/cordel-app/gymdesk/issues/19) | M | #17 #9 |
| P2.8 Member app: schedule, booking, waitlist | [#20](https://github.com/cordel-app/gymdesk/issues/20) | L | #19 #4 |

### Phase 3 — Class packages
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P3.1 class_packages catalog CRUD | [#21](https://github.com/cordel-app/gymdesk/issues/21) | S | #2 |
| P3.2 user_class_packages + credit transactions | [#22](https://github.com/cordel-app/gymdesk/issues/22) | L | #21 #10 |
| P3.3 Consume/refund credits on booking lifecycle | [#23](https://github.com/cordel-app/gymdesk/issues/23) | L | #22 #19 |
| P3.4 Member app: my packages + credit balance | [#24](https://github.com/cordel-app/gymdesk/issues/24) | M | #23 #12 |

### Phase 4 — Promotions
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P4.1 action_types + promotions CRUD | [#25](https://github.com/cordel-app/gymdesk/issues/25) | M | #2 |
| P4.2 Promotion plan targeting + charge benefits | [#26](https://github.com/cordel-app/gymdesk/issues/26) | M | #25 #10 |
| P4.3 promotion_period_benefits | [#27](https://github.com/cordel-app/gymdesk/issues/27) | S | #25 |
| P4.4 Apply promotions to memberships (price calc) | [#28](https://github.com/cordel-app/gymdesk/issues/28) | L | #26 #11 |
| P4.5 Backoffice + member app promotion surfaces | [#29](https://github.com/cordel-app/gymdesk/issues/29) | M | #28 #12 |

### Phase 5 — Workouts & training
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P5.1 muscles, exercises, exercise_muscles | [#30](https://github.com/cordel-app/gymdesk/issues/30) | L | #2 |
| P5.2 workouts + workout_exercises builder | [#31](https://github.com/cordel-app/gymdesk/issues/31) | L | #30 |
| P5.3 training_plan_templates | [#32](https://github.com/cordel-app/gymdesk/issues/32) | M | #31 |
| P5.4 Assign training_plans to members | [#33](https://github.com/cordel-app/gymdesk/issues/33) | M | #32 |
| P5.5 workout_logs + member training endpoints | [#34](https://github.com/cordel-app/gymdesk/issues/34) | M | #33 |
| P5.6 Member app: Training tab + set logging | [#35](https://github.com/cordel-app/gymdesk/issues/35) | L | #34 #4 |

### Phase 6 — Audit log
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P6.1 audit_logs table + recordAudit helper | [#36](https://github.com/cordel-app/gymdesk/issues/36) | M | — |
| P6.2 Instrument high-value mutation routes | [#37](https://github.com/cordel-app/gymdesk/issues/37) | M | #36 + phases 1–4 |
| P6.3 Backoffice audit viewer | [#38](https://github.com/cordel-app/gymdesk/issues/38) | M | #37 #2 |

### Phase 7 — Multi-location (superseded by Phase 9 / #59, 2026-07-15)
`gym_locations` was never built — closed in favor of `Center` (see Phase 9 above).

| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| ~~P7.1 gym_locations CRUD~~ | [#39](https://github.com/cordel-app/gymdesk/issues/39) (closed) | S | — |
| ~~P7.2 Locations on rooms, trainers, class types~~ | [#40](https://github.com/cordel-app/gymdesk/issues/40) (closed) | M | #39 |
| ~~P7.3 Per-location plan pricing + member filter~~ | [#41](https://github.com/cordel-app/gymdesk/issues/41) (closed) | M | #40 #7 |

### Phase 9 — Centers (#59)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| Center + member_centers + center_id backfill (backend) | [#59](https://github.com/cordel-app/gymdesk/issues/59) | L | — |
| Centers/Resources/Events admin UI + Member center assignment | [#59](https://github.com/cordel-app/gymdesk/issues/59) | L | backend |
| Member app center plumbing | [#59](https://github.com/cordel-app/gymdesk/issues/59) | S | backend |

### Phase 8 — Stripe payments (deferred)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P8.1 billing_provider_events + webhook endpoint | [#42](https://github.com/cordel-app/gymdesk/issues/42) | M | #10 |
| P8.2 Sync members/plans to Stripe | [#43](https://github.com/cordel-app/gymdesk/issues/43) | L | #42 |
| P8.3 Process Stripe webhooks into the ledger | [#44](https://github.com/cordel-app/gymdesk/issues/44) | L | #43 #10 |

## Member app follow-ups (spike #85, 2026-07-19)

**Already shipped** (member app parity with roadmap items): P2.8 schedule/booking (#20 closed), P1.8 membership + billing history (#12 closed), P5.6 training tab + set logging (#35 closed), P3.4 my packages (#24 closed).

**Gaps identified and new issues created** (prioritised by member value vs. backend readiness):

| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| Member home dashboard (upcoming booking + membership snapshot) | [#105](https://github.com/cordel-app/gymdesk/issues/105) | S | — |
| Member app: my class packages & credit balance | [#106](https://github.com/cordel-app/gymdesk/issues/106) | M | — |
| Member app: profile page (view & edit personal data) | [#107](https://github.com/cordel-app/gymdesk/issues/107) | M | — |

## Critical path

- **Billing**: P1.1 → P1.5 → P1.6 — the ledger unblocks packages (Phase 3), promotions (Phase 4), and Stripe (Phase 8).
- **Classes**: P2.3 → P2.4 → P2.5 — the session model unblocks everything class-related.
- Phases 3, 4, and 5 are parallelizable once their Phase 1/2 dependencies land.

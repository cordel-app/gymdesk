# Gymdesk Roadmap

What the product does today, what is still open, and the decisions that shape the next work. Every ticket is a GitHub issue in `cordel-app/gymdesk`; the issue body holds the scope and the acceptance criteria, this file is the map.

The record of how each ticket landed is `docs/changelog.md` — one entry per shipped ticket, by month. Nothing in this file is a diary: the Status table below is rewritten by area when an area's open item closes, never appended to.

## Status (2026-10-09)

Derived from the GitHub issue state on that date: **1,302 issues closed, 19 open** (6 of those 19 are work already merged whose issue stays open for a later stage or a deployment step — they are named under *Open work*).

| Area | State | Shipped | Open |
|---|---|---|---|
| Platform: gyms, centers, staff, roles, feature flags, audit log, Clerk, deploy & relays | Complete | Multi-tenant model, Centers, 7-role permission matrix with per-feature overrides, audit log with entity registry, Clerk invitations and orphan cleanup, Podman deploy with GitHub-sourced env, the four webhook/run relays through the admin app, Grafana logs and run-health alerts, gym Time & Localization settings (stages 1–2) | #1182 stage 2 (audit actor columns on ~18 tables, split into one PR per actor shape), #1246 stage 3 (the remaining date/number format sweep), #1323 (`docs/rules.md`, the product's rules stated for a person) |
| Membership Plans, Assigned Plans & billing | Complete, being refined | Plans with Billing & Duration, frozen Assigned Plan snapshots, Draft → Pending Payment → Active with Save & Pay, one plan per member with explicit replacement, Membership Fee and Billing Event simulations on all three cards, nightly run with dunning and gapless receipts, MONEI first payment and recurring charges, card replacement as a verification, cash payments | #1240 (Draft editing: PRs 1–2 merged; Effective Price VAT question open), #1288 stages 2+ (member-side plan configuration; stage 1 merged), #1304 (Billing Events details and table; shared plan with #1288 awaiting confirmation), #1191 (linked plans of a multi-member Membership; PR #1221 open), #1196 (cancel with an End Date; needs retyping for plan-first), #1184 (all four stages merged; issue to close) |
| Products & Promotions | Complete | Products with four billing frequencies, Mandatory and Sessions-package pricing, default Products at gym creation, Promotions with Applies To, Requirement, periodic Duration, lifecycle expiry sweep, Billing Event Simulation, Promotions applied to a member's purchase | #1121 stages 3–5 (stages 1–2 merged: catalogue and one-off purchase in the Members App) |
| Calendar, bookings & Professional Services | Complete | Activity Types and occurrences with per-occurrence Trainer, Space, Waitlist and Eligible Services, derived execution status, reactivation, 2-hour reminders, 24-hour cancellation window, Professional-Service eligibility gate, four-source session balance and the consumption ledger, refused bookings routed to the Products that unlock them | #1227 (member wallets: stage 1 PR #1279 open; stage 2 renewals) |
| Members (admin) | Complete | Tabbed Member card, Assigned Plans list shared with the Assigned Plans page, Payment Status across every billable concept, Access Rights, Clerk status dates, New Member rule, Products & Services tab | #1231 (Progress tab with per-exercise readings; decisions taken on the thread, not started) |
| Members App (web) | Complete, growing | Themed from one declaration, dashboard tiles, My Products & Services with the Payments card and the past plans, Add Plan with Promotions and declined benefits, Calendar with booking status text, My Goals with readings and charts, My Nutrition, Profile with language preference, avatar menu with confirmed Log out | #1224 (My Training Plan / My Progress tabs; plan revised, awaiting approval), #1288 stages 2+, #1121 stages 3–5, #1321 (Section Card effects; needs retyping for plan-first) |
| Mobile app (Capacitor shell) | WP1–WP4 done, WP5 in progress | Push tokens and FCM delivery, native detection and Google sign-in, the `apps/mobile` shell with one profile per app, universal links, CI debug builds listed in Cordel → Mobile builds, simulator/emulator pass on both platforms | #1077 (production credentials, store submission, release — none of its three criteria met), #1075 (Sign in with Apple: code merged behind a flag; blocked on the Apple Developer account), #1078 (epic) |
| Nutrition & Goals | Complete | Nutrition Library with three catalogues and food images, Nutrition Plan Templates and assigned plans, Personal Goals with targets, images, per-gym activation and duplicate, Assigned Personal Goals with readings, initial-reading periods, progress and charts, member-managed My Goals | #1229 (absolute vs relative targets; PR #1280 open) |
| Training & exercises | Complete | Base Exercise catalogue imported from the Free Exercise DB, server-side filters on all three exercise screens, one Exercise editor for both pages, image and video media with ownership rules, Workout and Training Plan Templates, Assigned Training Plans, block result units | #1224 (its exercise result-type migration) |
| Payments app & hosted page | Complete | Isolated `fitness-pay` container, Monei iframe page, locale-less return URLs, webhook relay | #1081 (repository half merged; the acceptance criterion needs a deployed environment) |

## Open work (2026-10-09)

Every open issue, with what has merged and what is left. An issue appears once, under the area it changes most.

**Billing & Assigned Plans**
- [#1288](https://github.com/cordel-app/gymdesk/issues/1288) Members App — select, configure and pay for a Membership Plan. Stage 1 merged (#1318): Save & Pay writes only the initial pending Billing Event plus its checkout, and a member never replaces a plan from the app. The owner's revised lifecycle decision (2026-10-09) governs the remaining stages and #1304.
- [#1304](https://github.com/cordel-app/gymdesk/issues/1304) Billing Events details and a simpler table. No code yet; the shared plan with #1288 is on the thread awaiting confirmation.
- [#1240](https://github.com/cordel-app/gymdesk/issues/1240) Draft Assigned Plans fully editable, UI aligned with Membership Plans. PR 1 (#1307, hard-delete Cancel and the Cancel/Save/Save & Pay row) and PR 2 (#1320, Members section side by side) merged; most of the layout alignment landed under #1243. Open question: whether Effective Price should show a VAT-inclusive figure.
- [#1191](https://github.com/cordel-app/gymdesk/issues/1191) Linked Assigned Plans of a multi-member Membership. PR #1221 open.
- [#1196](https://github.com/cordel-app/gymdesk/issues/1196) Cancel Membership with an End Date. Typed as a Task but needs design decisions (there are no future Billing Events to delete; `closed_at` already records the cancellation); waiting to be retyped as a normal issue.
- [#1184](https://github.com/cordel-app/gymdesk/issues/1184) `% Discount` and `Mandatory` on Plan benefits. Stages 1, 2, 3, 3b and 4 all merged (#1204, #1205, #1210, #1253, #1258). Nothing left but closing the issue.

**Products & Members App**
- [#1121](https://github.com/cordel-app/gymdesk/issues/1121) Additional Products & Services in the Members App. Stage 1 (#1156, the catalogue) and stage 2 (#1159, buying a one-off Product) merged; a recurring purchase and the later stages are open.
- [#1224](https://github.com/cordel-app/gymdesk/issues/1224) My Training Plan and My Progress tabs in the Members App. The owner's answers add a migration (an exercise's own result type) and an Admin change; the revised plan is on the thread awaiting approval.
- [#1321](https://github.com/cordel-app/gymdesk/issues/1321) Section Card visual effects, touch interactions and illustrated previews. Typed as a Task but asks for about ten new theme settings; waiting to be retyped so a plan can be written.

**Calendar & Professional Services**
- [#1227](https://github.com/cordel-app/gymdesk/issues/1227) Professional Services member wallets. Stage 1 (visible balance, transaction history, staff adjustment) has merged; stage 2 (nightly renewal of plan Session Benefit allowances, grant entries in the history) is in review. Nothing is left after it.

**Members & Goals**
- [#1231](https://github.com/cordel-app/gymdesk/issues/1231) Member Progress tab: one card per exercise with a graph and its readings; staff edit value and notes, never the date; no audit rows. Decisions taken 2026-10-08, not started.
- [#1229](https://github.com/cordel-app/gymdesk/issues/1229) Personal Goals: absolute vs relative targets. PR #1280 open (Maintenance relative, negative relative targets allowed, baseline fixed).

**Platform**
- [#1182](https://github.com/cordel-app/gymdesk/issues/1182) Standard audit metadata on every business entity. Stage 1 merged (#1203, the plain-text actor snapshot and its helpers). Stage 2 is about 18 tables across three actor shapes, proposed as one PR per shape (2a: the seven tables on #799's pair; 2b/2c: the rest); none started.
- [#1246](https://github.com/cordel-app/gymdesk/issues/1246) Gym Time & Localization settings. Stages 1 (#1271) and 2 (#1276, the Calendar) merged; stage 3's first pass (#1312, audit timestamps on three screens) merged. Left: date-only values, locale month names and the Members App.
- [#1323](https://github.com/cordel-app/gymdesk/issues/1323) `docs/rules.md`: the business rules that today live only in `CLAUDE.md`, one plain entry per rule with its ticket and the module that enforces it. Opened 2026-10-09 as the second half of the status review's item 13 (#1322 was the first); the file is written (188 entries, 16 sections); PR #1324 open.
- [#1081](https://github.com/cordel-app/gymdesk/issues/1081) Payment return pages follow the member's locale. Repository half merged (#1139) with a test gate; the acceptance check needs the deployed `PAYMENT_OK_URL`/`PAYMENT_KO_URL` to be set locale-less.

**Mobile app** — see the work-package table below.
- [#1077](https://github.com/cordel-app/gymdesk/issues/1077) WP5: the tooling landed (CI builds, Cordel → Mobile builds, the simulator findings fixed); production credentials, store submission and a release are not done.
- [#1075](https://github.com/cordel-app/gymdesk/issues/1075) WP3b: Sign in with Apple is merged behind `NEXT_PUBLIC_APPLE_SIGN_IN` (#1261) and the relay-email link works (#1209); verifying it needs the Apple Developer account.
- [#1078](https://github.com/cordel-app/gymdesk/issues/1078) The epic; closes with WP5.

## Decisions

- **Database (updated 2026-07-03)**: migrate from Neon PostgreSQL to **Oracle HeatWave MySQL**
  (paid tier, ~€50/mo) for predictable pricing and single-vendor infra. Tracked as
  **Phase M ([#45](https://github.com/cordel-app/gymdesk/issues/45)–[#49](https://github.com/cordel-app/gymdesk/issues/49))**, which **blocks Phase 1**. MySQL consequences for later tickets:
  partial unique indexes (P1.5, P2.5) become generated column + unique index; `jsonb`/`inet`
  (P6.1) become `JSON`/`VARCHAR(45)`; `RETURNING` is replaced by insert + select helpers.
- **Multi-location (updated 2026-07-15)**: shipped as **Phase 9 — Centers (#59)**, superseding
  the deferred Phase 7 `gym_locations` design (never built). `Center` is the single location
  concept; `Gym` remains the tenant boundary.
- **Payments**: internal `billing_events` ledger first (staff-recorded); MONEI is the active PSP for Phase 8 (replaced Stripe/Paycomet). Gymdesk owns all subscription logic; MONEI only tokenizes and charges. PCI scope minimized via isolated `fitness-pay` container at `pay.vdicube.com`.
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


## Shipped phases

The original phase plan, derived from the target ER model, is complete. One line per phase; the per-ticket detail is in `docs/changelog.md` under the month named.

| Phase | Tickets | Closed | Notes |
|---|---|---|---|
| M — MySQL migration | #45–#49 | 2026-07-04 | Neon PostgreSQL → Oracle HeatWave MySQL; Knex migrations, mysql2 data layer, cutover deploy |
| 0 — Foundation | #2–#4 | 2026-07-04 | Shared DataTable, CrudModal, ConfirmDialog, StatusBadge; member app shell |
| 0a — Structured logging | #177 | 2026-07-22 | pino in the API |
| 0b — Log shipping | #178 | 2026-07-22 | Grafana Alloy → Grafana Cloud Loki; config in `infra/alloy/`, deployed by `deploy-alloy.yml` |
| 1 — Membership plans & billing core | #5–#12 | 2026-07-12 | `fares` → `membership_plans`, `subscriptions` → `user_memberships`, `billing_events` ledger, member app My Membership |
| 2 — Classes v2 | #13, #15–#20 | 2026-07-12 | Rooms, class types, `class_sessions`, bookings with waitlist and attendance, member app schedule (#14 Specialities removed in #219) |
| 3 — Class packages | #21–#24 | 2026-07-12 | Package catalogue, credits, consume/refund on the booking lifecycle |
| 4 — Promotions | #25–#29 | 2026-07-12 | Promotions, plan targeting, apply to memberships, member app surfaces |
| 5 — Workouts & training | #30–#35 | 2026-07-12 | Exercises and muscles, workout builder, training plan templates, assignments, logs, member app Training tab |
| 6 — Audit log | #36–#38 | 2026-07-12 | `audit_logs`, `recordAudit`, instrumented routes, backoffice viewer |
| 9 — Centers | #59 | 2026-07-16 | `Center` as the single location concept; supersedes the never-built Phase 7 (`gym_locations`, #39–#41, closed) |
| Member app follow-ups | #105–#107 | 2026-07-19 | Home dashboard, class packages, profile — the gaps found by spike #85 |
| 8 — MONEI payments | #179–#185, #204, #205, #306 | 2026-08-17 → 2026-09-03 | Provider abstraction, payment requests and webhooks, the isolated `fitness-pay` page, recurring MIT run, cash payments and receipts, IP allowlist. Process documentation: `docs/payments.md` (#791). Old Stripe tickets #42–#44 superseded. |

Everything since (September–October 2026: the Assigned Plan snapshot, Draft/Pending states, Products, Professional Services, Personal Goals, the Members App theme, the mobile app, the relays) ran as individual issues rather than phases; `docs/changelog.md` lists them and the Status table above says where each area stands.

## Mobile app (Capacitor shell, planned 2026-10-04)

**Status (2026-10-09): WP1–WP4 done; WP5 in progress; nothing published.** Epic: [#1078](https://github.com/cordel-app/gymdesk/issues/1078). The Members App as an iOS/Android store app. **Stage 1 is one generic app ("Cordel Fitness")**; per-gym apps are a later stage on request and are designed for now. Plan, spike findings and design rules: `docs/mobile-app.md`; day-to-day operation: `docs/mobile-runbook.md`; decision: `docs/decisions.md` #18.

| Work package | Scope | State |
|---|---|---|
| WP1 [#1072](https://github.com/cordel-app/gymdesk/issues/1072) | `member_device_tokens` migration (with `app_id`), `POST`/`DELETE /me/devices`, FCM send from `sendNotification()` | **Done** 2026-10-05 |
| WP2 [#1073](https://github.com/cordel-app/gymdesk/issues/1073) | `apps/member`: `isNative()`, safe areas, `public/manifest.json`, native Google button, push registration, deep links | **Done** 2026-10-05 |
| WP3 [#1074](https://github.com/cordel-app/gymdesk/issues/1074) | `apps/mobile` Capacitor shell (iOS first, then Android), one profile per app | **Done** 2026-10-05 |
| WP3b [#1075](https://github.com/cordel-app/gymdesk/issues/1075) | Sign in with Apple (iOS), relay-email linking | Code merged behind a flag; **blocked** on the Apple Developer account |
| WP4 [#1076](https://github.com/cordel-app/gymdesk/issues/1076) | Universal links / app links (invitation links open the app) | **Done** 2026-10-06 (code); verification needs the Team ID and Android fingerprints on a device |
| WP5 [#1077](https://github.com/cordel-app/gymdesk/issues/1077) | Production Clerk/Google/Apple credentials, own mail domain, store listings, TestFlight/Play internal track | **In progress**: CI debug builds, Cordel → Mobile builds and the simulator/emulator pass are done; credentials, submission and release are not |

## Critical path (2026-10-09)

- **Billing lifecycle**: the owner's 2026-10-09 decision on #1288 (Save & Pay creates only the initial Billing Event; the webhook activates in one idempotent commit) is the one rule #1288's remaining stages and #1304 both implement. #1304 cannot start until that shared plan is confirmed; #1240's last question (Effective Price) and #1196 (End Date) sit behind it.
- **Members App growth**: #1224 (training and progress tabs) needs its plan approved and carries a migration; #1231 (the admin Progress tab) reads the same exercise logs, so the two should land in that order.
- **Mobile release**: #1075 and #1077 are blocked on accounts rather than code — the Apple Developer account, production Clerk/Google/Firebase credentials and the store listings. Nothing in the repository unblocks them.
- **Independent**: #1227, #1229, #1191 (PRs open), #1182 stage 2, #1246 stage 3 and #1121's later stages have no dependency on the above.

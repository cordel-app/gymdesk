# Gymdesk Roadmap

Phased implementation roadmap derived from the target ER model, adapted to the existing
multi-tenant architecture (every table gets `gym_id`; the diagram's monolithic `User` maps
onto the existing `members` + `gym_memberships` split — no new users table).

Each ticket below is a GitHub issue in `cordel-app/gymdesk`. Full scope and acceptance
criteria live in the issue bodies; this doc is the map.

## Decisions

- **Database (updated 2026-07-03)**: migrate from Neon PostgreSQL to **Oracle HeatWave MySQL**
  (paid tier, ~€50/mo) for predictable pricing and single-vendor infra. Tracked as
  **Phase M ([#45](https://github.com/cordel-app/gymdesk/issues/45)–[#49](https://github.com/cordel-app/gymdesk/issues/49))**, which **blocks Phase 1**. MySQL consequences for later tickets:
  partial unique indexes (P1.5, P2.5) become generated column + unique index; `jsonb`/`inet`
  (P6.1) become `JSON`/`VARCHAR(45)`; `RETURNING` is replaced by insert + select helpers.
- **Multi-location** is deferred to Phase 7 (additive nullable FKs; nothing earlier blocks on it).
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
(`requireRole` guards, `gym_id` filter, 23505→409) → register in `backend/src/index.ts` →
backoffice page (Members page as staff-level/soft-delete template, Fares page as admin-only
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

### Phase 7 — Multi-location (deferred)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P7.1 gym_locations CRUD | [#39](https://github.com/cordel-app/gymdesk/issues/39) | S | — |
| P7.2 Locations on rooms, trainers, class types | [#40](https://github.com/cordel-app/gymdesk/issues/40) | M | #39 |
| P7.3 Per-location plan pricing + member filter | [#41](https://github.com/cordel-app/gymdesk/issues/41) | M | #40 #7 |

### Phase 8 — Stripe payments (deferred)
| Ticket | Issue | Size | Depends on |
|---|---|---|---|
| P8.1 billing_provider_events + webhook endpoint | [#42](https://github.com/cordel-app/gymdesk/issues/42) | M | #10 |
| P8.2 Sync members/plans to Stripe | [#43](https://github.com/cordel-app/gymdesk/issues/43) | L | #42 |
| P8.3 Process Stripe webhooks into the ledger | [#44](https://github.com/cordel-app/gymdesk/issues/44) | L | #43 #10 |

## Critical path

- **Billing**: P1.1 → P1.5 → P1.6 — the ledger unblocks packages (Phase 3), promotions (Phase 4), and Stripe (Phase 8).
- **Classes**: P2.3 → P2.4 → P2.5 — the session model unblocks everything class-related.
- Phases 3, 4, and 5 are parallelizable once their Phase 1/2 dependencies land.

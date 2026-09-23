/**
 * #635 stage 2: the Assigned Membership Plan keeps its own snapshot of the
 * commercial configuration it was assigned with.
 *
 * §11–§14 of the ticket: once a Plan is assigned, the assignment is its own
 * contract. A later edit to the Membership Plan, to a Promotion or to a
 * Sellable Item's price must not move what an existing assignment bills.
 * Today most of that is resolved live at read time (`billing-simulation.ts`
 * joins `membership_plans`, `billing_policies`, `membership_plan_prices` and
 * `gym_charges` on every request), so this migration adds the parallel
 * structures the assignment can own instead.
 *
 * What lands here:
 *
 *   1. **Billing & Duration + cadence + regular fee on `user_memberships`** —
 *      `free_months` / `paid_months` / `bonus_months` mirror the Plan columns
 *      added in migration 173 (and the Promotion ones from 102), nullable for
 *      the same reason: "never configured" must stay distinguishable from an
 *      explicit 0. `recurring_billing_interval` / `recurring_billing_unit`
 *      freeze the Plan's `billing_policies` cadence (§11 "Billing
 *      frequencies"), and `membership_fee_price` freezes the regular,
 *      pre-Promotion Membership Fee — the price window that covered the
 *      assignment's start date. `final_price` is not a substitute: it is the
 *      *agreed* price after promotions and manual discounts, so the regular
 *      price a benefit is measured against has nowhere else to live.
 *
 *   2. **`user_membership_session` / `_oneoff` / `_periodical`** — the
 *      assignment's own copy of the Plan's three benefit sections (migration
 *      173), carrying the Sellable Item's name, type, billing frequency and
 *      price *as they were at assignment time* (§17). `gym_charge_id` is kept
 *      as a reference but is never the source of the price again.
 *
 *   3. **Pricing on the Promotion benefit snapshots** — migration 156 created
 *      `user_membership_promotion_{session,oneoff,periodical}_snapshot` with
 *      only the item name and quantity, which is not enough to reproduce a
 *      charge. They gain the same four pricing columns, so §16/§17 hold for
 *      Promotion-granted items too.
 *
 *   4. **Pricing on `user_membership_services`** — Additional Periodic
 *      Services (#631, migration 164) deliberately read price and frequency
 *      live from `gym_charges`. §11 lists Additional Services and their
 *      Sellable Item prices as part of the snapshot, so the attachment now
 *      captures them at attach time too. Nullable: a NULL means a row that
 *      predates the snapshot, and the reader falls back to the live join.
 *
 * Existing assignments are backfilled from the live catalogue below rather
 * than deleted. The #635 thread's Q3 answer allows hard-deleting them ("No
 * need to run a migration. you can hard delete all assigned plans"), but a
 * backfill reaches the same end state without destroying history: the values
 * captured are today's, which is exactly what those assignments already
 * resolve to live today, so nothing they bill changes. §18's "do not silently
 * reinterpret legacy data" is respected — no legacy concept is remapped here,
 * the same numbers are simply written down.
 *
 * Nothing *reads* the snapshot for billing yet: that cutover is stage 3, which
 * is also where the fallback for pre-snapshot rows lives. This migration only
 * adds structures and fills them.
 *
 * Each DDL statement is guarded independently via `information_schema` /
 * `hasColumn`, not folded behind one check: MySQL commits DDL implicitly, so a
 * crash between two statements must never leave a re-run skipping the rest
 * (see migrations 134/140/155/173 for the same pattern).
 *
 * Three things the backfill deliberately does or does not do:
 *
 *   - **`gym_charges.name` and `.type` are nullable** (a system charge takes
 *     its display name from `charge_types`), so every copy of them resolves
 *     `COALESCE(gc.name, ct.name, 'Sellable Item #<id>')` and
 *     `COALESCE(gc.type, 'other')` — the same fallback `loadChargeBenefitsSnapshot`
 *     already uses. Without it one such row would abort the migration under
 *     `STRICT_TRANS_TABLES`, after the DDL above had already committed.
 *   - **An assignment with a NULL `gym_id`** (the column has no NOT NULL) is
 *     not reachable by these statements — both joins compare it — so it keeps
 *     no snapshot and reads back as `snapshot_captured: false`, which is the
 *     signal stage 3 falls back on. Same for an assignment with no Plan.
 *   - **Benefit rows are copied only for assignments that still bill.** A
 *     `cancelled`/`expired` assignment would otherwise be stamped with today's
 *     catalogue under the heading "what was agreed", and nothing downstream
 *     bills it anyway. Its durations/cadence/fee are still filled: those the
 *     price-window subquery resolves for the assignment's own start date.
 *
 * `currency VARCHAR(3)` narrows `gym_charges.currency VARCHAR(10)`. It fits
 * only because `gym_charges_currency_check` pins the value to 'EUR', and
 * matches the six sibling tables; relaxing that CHECK for multi-currency means
 * widening these columns in the same change.
 *
 * The three new tables get named CHECKs for their enum-like columns (the
 * project's VARCHAR-plus-CHECK convention), which is free on an empty table.
 * `user_memberships.recurring_billing_unit` deliberately gets none: its only
 * writer copies `billing_policies.recurring_billing_unit`, itself an ENUM, and
 * adding a CHECK to a table this size is an ALGORITHM=COPY rebuild of the
 * busiest table in the schema (see migration 170's note in
 * `docs/go-to-production.md`) — not a trade worth making for a value the
 * source column already constrains.
 */

const BENEFIT_TABLES = [
  'user_membership_session',
  'user_membership_oneoff',
  'user_membership_periodical',
];

const PROMOTION_SNAPSHOT_TABLES = [
  'user_membership_promotion_session_snapshot',
  'user_membership_promotion_oneoff_snapshot',
  'user_membership_promotion_periodical_snapshot',
];

const PLAN_BENEFIT_SOURCE = {
  user_membership_session: 'membership_plan_session',
  user_membership_oneoff: 'membership_plan_oneoff',
  user_membership_periodical: 'membership_plan_periodical',
};

// `gym_charges.name`/`.type` are nullable — a system charge displays under its
// `charge_types` name — so every copy of them resolves the same fallback the
// existing snapshot readers use, and never writes a NULL into a NOT NULL
// column (which would abort the migration mid-flight under STRICT_TRANS_TABLES).
const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

// The assignment's own copy of the Sellable Item's commercial facts. The same
// column set everywhere a Sellable Item is snapshotted by this migration; the
// migration-156 promotion tables keep their own `gym_charge_name` from before.
function addItemSnapshotColumns(t, { nullable }) {
  const name = t.string('item_name', 255);
  const type = t.string('item_type', 32);
  const price = t.decimal('unit_price', 10, 2);
  if (nullable) {
    name.nullable();
    type.nullable();
    price.nullable();
  } else {
    name.notNullable();
    type.notNullable();
    price.notNullable().defaultTo(0);
  }
  t.string('item_billing_frequency', 20).nullable();
  t.string('currency', 3).nullable();
}

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

const UM_COLUMNS = {
  free_months: (t) => t.integer('free_months').unsigned().nullable(),
  paid_months: (t) => t.integer('paid_months').unsigned().nullable(),
  bonus_months: (t) => t.integer('bonus_months').unsigned().nullable(),
  recurring_billing_interval: (t) => t.integer('recurring_billing_interval').unsigned().nullable(),
  recurring_billing_unit: (t) => t.string('recurring_billing_unit', 10).nullable(),
  membership_fee_price: (t) => t.decimal('membership_fee_price', 10, 2).nullable(),
};

exports.up = async (knex) => {
  // ── 1. Billing & Duration, cadence and regular fee on the assignment ───────
  for (const [column, add] of Object.entries(UM_COLUMNS)) {
    if (!(await knex.schema.hasColumn('user_memberships', column))) {
      await knex.schema.alterTable('user_memberships', add);
    }
  }

  // ── 2. The assignment's own benefit rows ──────────────────────────────────
  for (const table of BENEFIT_TABLES) {
    if (!(await knex.schema.hasTable(table))) {
      await knex.schema.createTable(table, (t) => {
        t.increments('id').primary();
        t.specificType('gym_id', 'char(36)').notNullable()
          .references('id').inTable('gyms').onDelete('CASCADE');
        t.integer('user_membership_id').unsigned().notNullable()
          .references('id').inTable('user_memberships').onDelete('CASCADE');
        // No ON DELETE CASCADE, unlike the Plan-side tables of migration 173:
        // this row is the historical record of what was agreed, so it must
        // survive the Sellable Item being retired (gym_charges are only ever
        // soft-deleted — same reasoning as migrations 130 and 164).
        t.integer('gym_charge_id').unsigned().notNullable()
          .references('id').inTable('gym_charges');
        t.integer('quantity').unsigned().notNullable().defaultTo(1);
        addItemSnapshotColumns(t, { nullable: false });
        t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));

        // One row per (assignment, item) per section — the snapshot is written
        // once per assignment, this is the backstop against a double write.
        t.unique(['user_membership_id', 'gym_charge_id'], `${table}_membership_charge_unique`);
        t.index(['gym_id'], `${table}_gym_id_index`);
      });
    }

    // Each CHECK is guarded on its own name: CREATE TABLE and every ADD
    // CONSTRAINT are separate non-transactional statements.
    const CHECKS = {
      [`chk_${table}_quantity`]: 'quantity > 0',
      [`chk_${table}_item_type`]:
        "item_type IN ('fee', 'service', 'sessions', 'merchandise', 'other')",
      [`chk_${table}_item_frequency`]:
        "item_billing_frequency IS NULL OR item_billing_frequency IN "
        + "('once', 'per_session', 'four_weeks', 'week', 'month', 'year')",
    };
    for (const [name, expression] of Object.entries(CHECKS)) {
      if (!(await constraintExists(knex, table, name))) {
        await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression})`);
      }
    }
  }

  // ── 3. Pricing on the migration-156 Promotion benefit snapshots ───────────
  for (const table of PROMOTION_SNAPSHOT_TABLES) {
    if (!(await knex.schema.hasColumn(table, 'unit_price'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('item_type', 32).nullable();
        t.string('item_billing_frequency', 20).nullable();
        t.decimal('unit_price', 10, 2).nullable();
        t.string('currency', 3).nullable();
      });
    }
  }

  // ── 4. Pricing on Additional Periodic Services ────────────────────────────
  if (!(await knex.schema.hasColumn('user_membership_services', 'unit_price'))) {
    await knex.schema.alterTable('user_membership_services', (t) => {
      addItemSnapshotColumns(t, { nullable: true });
    });
  }

  // ── 5. Backfill (see the header) ──────────────────────────────────────────
  // Durations and cadence come from the Plan and its billing policy; the
  // regular fee from the price window that covered the assignment's start
  // date, which is what `effectivePrice()` resolves at assignment time.
  // Only rows that have no snapshot yet are touched, so a re-run is a no-op.
  await knex.raw(`
    UPDATE user_memberships um
      JOIN membership_plans p ON p.id = um.membership_plan_id AND p.gym_id = um.gym_id
      LEFT JOIN billing_policies bp ON bp.membership_plan_id = p.id AND bp.gym_id = um.gym_id
    SET um.free_months = p.free_months,
        um.paid_months = p.paid_months,
        um.bonus_months = p.bonus_months,
        um.recurring_billing_interval = bp.recurring_billing_interval,
        um.recurring_billing_unit = bp.recurring_billing_unit,
        um.membership_fee_price = (
          SELECT mpp.price FROM membership_plan_prices mpp
          WHERE mpp.membership_plan_id = p.id AND mpp.gym_id = um.gym_id
            AND mpp.valid_from <= um.starts_at
            AND (mpp.valid_to IS NULL OR mpp.valid_to >= um.starts_at)
          ORDER BY (mpp.status = 'inactive') ASC, mpp.valid_from DESC, mpp.id DESC
          LIMIT 1
        )
    WHERE um.membership_fee_price IS NULL
      AND um.free_months IS NULL AND um.paid_months IS NULL AND um.bonus_months IS NULL
      AND um.recurring_billing_interval IS NULL AND um.recurring_billing_unit IS NULL
  `);

  // The Plan benefit tables are new in migration 173 and empty in practice, so
  // this normally copies nothing — it exists so an assignment made between the
  // two migrations does not end up as the only one without benefit rows.
  for (const table of BENEFIT_TABLES) {
    await knex.raw(`
      INSERT INTO ${table}
        (gym_id, user_membership_id, gym_charge_id, quantity,
         item_name, item_type, item_billing_frequency, unit_price, currency)
      SELECT um.gym_id, um.id, b.gym_charge_id, b.quantity,
             ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
             gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency
      FROM user_memberships um
      JOIN ${PLAN_BENEFIT_SOURCE[table]} b
        ON b.membership_plan_id = um.membership_plan_id AND b.gym_id = um.gym_id
      JOIN gym_charges gc ON gc.id = b.gym_charge_id
      LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      LEFT JOIN ${table} existing ON existing.user_membership_id = um.id
      WHERE existing.id IS NULL
        AND um.status NOT IN ('cancelled', 'expired')
    `);
  }

  await knex.raw(`
    UPDATE user_membership_services ums
      JOIN gym_charges gc ON gc.id = ums.gym_charge_id
      LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
    SET ums.item_name = ${ITEM_NAME_EXPR},
        ums.item_type = ${ITEM_TYPE_EXPR},
        ums.item_billing_frequency = gc.billing_frequency,
        ums.unit_price = COALESCE(gc.amount, 0),
        ums.currency = gc.currency
    WHERE ums.unit_price IS NULL
  `);

  // LEFT JOIN, not JOIN: migration 156 made `gym_charge_id` nullable with
  // ON DELETE SET NULL, so a row whose Sellable Item was hard-deleted has no
  // item left to price. Those rows cannot be recovered — they get a 0 and the
  // name migration 156 already froze, which is all that survives of them.
  for (const table of PROMOTION_SNAPSHOT_TABLES) {
    await knex.raw(`
      UPDATE ${table} s
        LEFT JOIN gym_charges gc ON gc.id = s.gym_charge_id
      SET s.item_type = IF(gc.id IS NULL, NULL, ${ITEM_TYPE_EXPR}),
          s.item_billing_frequency = gc.billing_frequency,
          s.unit_price = COALESCE(gc.amount, 0),
          s.currency = COALESCE(gc.currency, 'EUR')
      WHERE s.unit_price IS NULL
    `);
  }
};

exports.down = async (knex) => {
  for (const table of BENEFIT_TABLES) {
    await knex.schema.dropTableIfExists(table);
  }

  for (const column of ['item_name', 'item_type', 'item_billing_frequency', 'unit_price', 'currency']) {
    if (await knex.schema.hasColumn('user_membership_services', column)) {
      await knex.schema.alterTable('user_membership_services', (t) => t.dropColumn(column));
    }
  }

  for (const table of PROMOTION_SNAPSHOT_TABLES) {
    for (const column of ['item_type', 'item_billing_frequency', 'unit_price', 'currency']) {
      if (await knex.schema.hasColumn(table, column)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(column));
      }
    }
  }

  for (const column of Object.keys(UM_COLUMNS)) {
    if (await knex.schema.hasColumn('user_memberships', column)) {
      await knex.schema.alterTable('user_memberships', (t) => t.dropColumn(column));
    }
  }
};

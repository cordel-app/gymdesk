/**
 * #635 stage 4 (part 1): retire **Charge Benefits**.
 *
 * §2 of the ticket: "Remove the Charge Benefits concept completely from
 * Membership Plans [and] Assigned Membership Plans ... Charge Benefits must
 * disappear from the UI completely". Q4 on the issue asked whether the legacy
 * tables should instead be kept read-only until a separate cleanup ticket, and
 * was answered "Yes, clean up completely these legacy structure."
 *
 * So both tables go:
 *
 *   - `plan_charge_benefits`            (migrations 089 / 091) — the
 *     Membership Plan's waive/discount configuration per Sellable Item.
 *   - `user_membership_charge_benefits` (migration 130) — its assignment-time
 *     snapshot.
 *
 * §18 asks that the legacy structures not be deleted blindly, so what read
 * them, and why dropping them is safe now:
 *
 *   - **Billing.** Nothing. Since stage 3 (#714) every surface that prices or
 *     schedules an assignment reads the Assigned Plan snapshot
 *     (`user_memberships.*` + `user_membership_{session,oneoff,periodical}` +
 *     the promotion snapshots). `user_membership_charge_benefits` was never
 *     part of that path — it was display-only on the Assigned Plan card.
 *   - **The Plan Billing Forecast (#485).** Read `plan_charge_benefits` to
 *     build its benefit lines. It is a read-only projection computed per
 *     request and never persisted, so it simply stops showing benefit
 *     adjustments; the plan fee and its cadence are unaffected.
 *   - **`GET /membership-plans/:id/charge-benefits` + `PUT`** and the
 *     `CHARGE BENEFITS` section on the Plans page, all removed in this PR.
 *
 * Note this is **not** the whole of stage 4: Included Services
 * (`plan_allowances`) is deliberately left in place. Unlike Charge Benefits it
 * is not a commercial concept — `plan-allowances.ts` gates every booking on it
 * and `package-credits.ts` derives bookable credits from it — and the ticket's
 * replacement (Session Benefits) is keyed to a Sellable Item rather than an
 * activity type, so there is no one-to-one mapping §18 would accept. See the
 * open question on #635.
 *
 * `down` recreates both tables empty, with the shape migrations 089/091 and
 * 130 left them in. The rows themselves are gone for good, and deliberately
 * not archived into a side table: a Plan's Charge Benefits have no home in the
 * new benefit structure (a Charge Benefit was a waive/discount *on* an item,
 * while a Plan's Period Benefit is a *charged* item — no one-to-one mapping,
 * which is what §18 would require), Q3 answered that existing assignments may
 * simply be hard-deleted, and anything historical an assignment needs to bill
 * correctly already lives in its own #635 snapshot (§13/§14). A table nothing
 * can read would be schema cruft, not insurance.
 *
 * One deployment note, since this is the first non-additive migration in the
 * #635 chain: run it *after* the API build that stops reading the tables is
 * live. The reverse order leaves the previous build 500ing on
 * `ER_NO_SUCH_TABLE`. Tracked in `docs/go-to-production.md`.
 */

exports.up = async (knex) => {
  // Snapshot first, then source: nothing FKs from one to the other (both point
  // at gym_charges), but dropping the derived table first keeps the order
  // readable and matches how they were created.
  await knex.schema.dropTableIfExists('user_membership_charge_benefits');
  await knex.schema.dropTableIfExists('plan_charge_benefits');
};

// CREATE TABLE and each ADD CONSTRAINT are separate non-transactional
// statements, so one hasTable() guard around all of them would let a crash
// mid-way leave a re-run skipping the constraints for good. Each is guarded on
// its own, the way migrations 089 and 173 do it.
const hasConstraint = async (knex, table, name) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('plan_charge_benefits'))) {
    await knex.schema.createTable('plan_charge_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable()
        .references('id').inTable('membership_plans').onDelete('CASCADE');
      t.integer('gym_charge_id').unsigned().notNullable();
      t.string('action', 30).notNullable().defaultTo('no_benefit');
      t.decimal('value', 10, 2).nullable();
      t.unique(['membership_plan_id', 'gym_charge_id'], { indexName: 'pcb_plan_gym_charge_unique' });
    });
  }
  if (!(await hasConstraint(knex, 'plan_charge_benefits', 'pcb_gym_charge_id_foreign'))) {
    await knex.raw(
      'ALTER TABLE plan_charge_benefits ADD CONSTRAINT `pcb_gym_charge_id_foreign` ' +
      'FOREIGN KEY (`gym_charge_id`) REFERENCES `gym_charges` (`id`) ON DELETE CASCADE',
    );
  }
  if (!(await hasConstraint(knex, 'plan_charge_benefits', 'chk_pcb_action'))) {
    await knex.raw(
      "ALTER TABLE plan_charge_benefits ADD CONSTRAINT chk_pcb_action " +
      "CHECK (action IN ('no_benefit','waive','percentage_discount','fixed_discount'))",
    );
  }
  if (!(await hasConstraint(knex, 'plan_charge_benefits', 'chk_pcb_value'))) {
    await knex.raw(
      "ALTER TABLE plan_charge_benefits ADD CONSTRAINT chk_pcb_value " +
      "CHECK (action IN ('no_benefit','waive') " +
      "OR (action IN ('percentage_discount','fixed_discount') AND value IS NOT NULL))",
    );
  }

  if (!(await knex.schema.hasTable('user_membership_charge_benefits'))) {
    await knex.schema.createTable('user_membership_charge_benefits', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('user_membership_id').unsigned().notNullable()
        .references('id').inTable('user_memberships').onDelete('CASCADE');
      // No ON DELETE CASCADE, as migration 130 had it: the snapshot outlives a
      // retired Sellable Item.
      t.integer('gym_charge_id').unsigned().notNullable()
        .references('id').inTable('gym_charges');
      t.string('action', 30).notNullable();
      t.decimal('value', 10, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.unique(['user_membership_id', 'gym_charge_id'], { indexName: 'umcb_membership_charge_unique' });
      t.index(['user_membership_id'], 'umcb_membership_index');
    });
  }
  if (!(await hasConstraint(knex, 'user_membership_charge_benefits', 'chk_umcb_action'))) {
    await knex.raw(
      "ALTER TABLE user_membership_charge_benefits ADD CONSTRAINT chk_umcb_action " +
      "CHECK (action IN ('waive','percentage_discount','fixed_discount'))",
    );
  }
  if (!(await hasConstraint(knex, 'user_membership_charge_benefits', 'chk_umcb_value'))) {
    await knex.raw(
      "ALTER TABLE user_membership_charge_benefits ADD CONSTRAINT chk_umcb_value " +
      "CHECK (action = 'waive' OR value IS NOT NULL)",
    );
  }
};

/**
 * #635 stage 1: align Membership Plans with the Promotion benefit structure.
 *
 * A Membership Plan gets the same two things a Promotion already has:
 *
 *   1. **Billing & Duration** — `free_months` / `paid_months` / `bonus_months`
 *      on `membership_plans`, mirroring the columns `promotions` carries since
 *      migration 102. Nullable, exactly like the Promotion ones: "not
 *      configured" is a real state and must stay distinguishable from an
 *      explicit 0 (a plan that has never been given a duration must not read
 *      as "0 free / 0 paid / 0 bonus"). `pay_beforehand_months` is deliberately
 *      NOT added — §7 of the ticket lists Free Period, Paid Duration and Bonus
 *      Duration only.
 *
 *   2. **One-off / Session / Period Benefits** — three tables keyed to a real
 *      Sellable Item (`gym_charges`), the exact shape migration 155 gave
 *      Promotions, sectioned by `classifySellableItem()`:
 *        - membership_plan_session     -> type = 'sessions'
 *        - membership_plan_oneoff      -> type != 'sessions', non-recurring
 *        - membership_plan_periodical  -> type != 'sessions', recurring
 *          (the period is the Sellable Item's own `billing_frequency`, read
 *          live via the FK join — not stored here, not editable per-benefit)
 *
 * Scope note (stage 1 of the plan agreed on #635): this is additive only.
 * `plan_allowances` ("Included Services") and `plan_charge_benefits` ("Charge
 * Benefits") are untouched and still load-bearing — `package-credits.ts` derives
 * bookable credits from the former and the Plan Billing Forecast reads the
 * latter. Retiring them is stage 4, after the Assigned Plan snapshot (stage 2)
 * and the billing cutover (stage 3) exist. Nothing here changes what any
 * existing plan bills: the new columns are NULL and the new tables are empty
 * until an admin fills them in.
 *
 * The Assigned Plan (`user_memberships`) deliberately gets nothing yet — its
 * parallel snapshot structures are stage 2, so this migration cannot be the
 * thing that makes an assignment start reading a half-built snapshot.
 *
 * CREATE TABLE and ADD CONSTRAINT are separate non-transactional DDL
 * statements, so each CHECK is guarded independently via information_schema
 * rather than folded into the same hasTable() check — a crash between the two
 * must not leave a re-run permanently skipping the CHECK (see migrations
 * 134/140/155 for precedent). The same applies to the three column adds, which
 * is why each is guarded by its own hasColumn().
 */

const BENEFIT_TABLES = ['membership_plan_session', 'membership_plan_oneoff', 'membership_plan_periodical'];

const DURATION_COLUMNS = ['free_months', 'paid_months', 'bonus_months'];

exports.up = async (knex) => {
  // ── 1. Billing & Duration on the plan itself ──────────────────────────────
  for (const column of DURATION_COLUMNS) {
    if (!(await knex.schema.hasColumn('membership_plans', column))) {
      await knex.schema.alterTable('membership_plans', (t) => {
        t.integer(column).unsigned().nullable();
      });
    }
  }

  // ── 2. Sellable-Item-keyed benefit tables ─────────────────────────────────
  for (const table of BENEFIT_TABLES) {
    if (!(await knex.schema.hasTable(table))) {
      await knex.schema.createTable(table, (t) => {
        t.increments('id').primary();
        t.specificType('gym_id', 'char(36)').notNullable()
          .references('id').inTable('gyms').onDelete('CASCADE');
        t.integer('membership_plan_id').unsigned().notNullable()
          .references('id').inTable('membership_plans').onDelete('CASCADE');
        t.integer('gym_charge_id').unsigned().notNullable()
          .references('id').inTable('gym_charges').onDelete('CASCADE');
        t.integer('quantity').unsigned().notNullable().defaultTo(1);
        t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
        t.integer('created_by_membership_id').unsigned().nullable()
          .references('id').inTable('gym_memberships').onDelete('SET NULL');

        // One row per (plan, item) per section — the editor is replace-all and
        // rejects duplicates, this is the backstop.
        t.unique(['membership_plan_id', 'gym_charge_id'], `${table}_plan_charge_unique`);
        t.index(['gym_id'], `${table}_gym_id_index`);
      });
    }

    const constraintName = `chk_${table}_quantity`;
    const [[checkExists]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
      [table, constraintName],
    );
    if (checkExists.cnt === 0) {
      await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} CHECK (quantity > 0)`);
    }
  }
};

exports.down = async (knex) => {
  for (const table of BENEFIT_TABLES) {
    await knex.schema.dropTableIfExists(table);
  }
  for (const column of DURATION_COLUMNS) {
    if (await knex.schema.hasColumn('membership_plans', column)) {
      await knex.schema.alterTable('membership_plans', (t) => t.dropColumn(column));
    }
  }
};

/**
 * #272: Promotions Comprehensive Redesign
 *
 * 1. promotions:
 *    - Rename free_period_paid_months → paid_months
 *    - Rename free_period_bonus_months → bonus_months
 *    - Add free_months (initial period before any charge)
 *
 * 2. promotion_period_benefits:
 *    - Add duration_months (how long the benefit runs, independent of promotion dates)
 *
 * 3. promotion_charge_benefits:
 *    - Expand action CHECK to include 'fixed_price'
 *
 * 4. New table promotion_included_benefits (one-time Sellable Item grants)
 */

exports.up = async (knex) => {
  // ── 1. promotions ──────────────────────────────────────────────────────────

  const hasPaidMonths = await knex.schema.hasColumn('promotions', 'paid_months');
  if (!hasPaidMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.renameColumn('free_period_paid_months', 'paid_months');
    });
  }

  const hasBonusMonths = await knex.schema.hasColumn('promotions', 'bonus_months');
  if (!hasBonusMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.renameColumn('free_period_bonus_months', 'bonus_months');
    });
  }

  const hasFreeMonths = await knex.schema.hasColumn('promotions', 'free_months');
  if (!hasFreeMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.integer('free_months').unsigned().nullable().after('bonus_months');
    });
  }

  // ── 2. promotion_period_benefits ───────────────────────────────────────────

  const hasDurationMonths = await knex.schema.hasColumn('promotion_period_benefits', 'duration_months');
  if (!hasDurationMonths) {
    await knex.schema.alterTable('promotion_period_benefits', (t) => {
      t.integer('duration_months').unsigned().nullable().after('frequency_unit');
    });
  }

  // ── 3. promotion_charge_benefits: expand action CHECK ──────────────────────

  await knex.raw('ALTER TABLE promotion_charge_benefits DROP CHECK pcb_action_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE promotion_charge_benefits ADD CONSTRAINT pcb_action_check " +
    "CHECK (action IN ('no_benefit','waive','percentage_discount','fixed_discount','fixed_price'))",
  );

  // ── 4. promotion_included_benefits ─────────────────────────────────────────

  const hasIncluded = await knex.schema.hasTable('promotion_included_benefits');
  if (!hasIncluded) {
    await knex.schema.createTable('promotion_included_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types');
      t.integer('quantity').unsigned().notNullable().defaultTo(1);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['promotion_id'], 'pib_promotion_idx');
    });

    await knex.raw(
      'ALTER TABLE promotion_included_benefits ADD CONSTRAINT pib_positive_check CHECK (quantity > 0)',
    );
  }
};

exports.down = async (knex) => {
  // Drop included benefits table
  await knex.raw('ALTER TABLE promotion_included_benefits DROP CHECK pib_positive_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotion_included_benefits');

  // Revert charge_benefits action CHECK
  await knex.raw('ALTER TABLE promotion_charge_benefits DROP CHECK pcb_action_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE promotion_charge_benefits ADD CONSTRAINT pcb_action_check " +
    "CHECK (action IN ('no_benefit','waive','percentage_discount','fixed_discount'))",
  );

  // Revert period_benefits duration_months
  const hasDurationMonths = await knex.schema.hasColumn('promotion_period_benefits', 'duration_months');
  if (hasDurationMonths) {
    await knex.schema.alterTable('promotion_period_benefits', (t) => {
      t.dropColumn('duration_months');
    });
  }

  // Revert promotions columns
  const hasFreeMonths = await knex.schema.hasColumn('promotions', 'free_months');
  if (hasFreeMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.dropColumn('free_months');
    });
  }

  const hasBonusMonths = await knex.schema.hasColumn('promotions', 'bonus_months');
  if (hasBonusMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.renameColumn('bonus_months', 'free_period_bonus_months');
    });
  }

  const hasPaidMonths = await knex.schema.hasColumn('promotions', 'paid_months');
  if (hasPaidMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.renameColumn('paid_months', 'free_period_paid_months');
    });
  }
};

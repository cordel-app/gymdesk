/**
 * #214: Promotions UX Redesign
 *
 * 1. promotions table:
 *    - Rename status → lifecycle_status, expand CHECK to include 'deleted'
 *    - Add deleted_at, deleted_by_membership_id (soft delete)
 *    - Add free_period_paid_months, free_period_bonus_months
 *    - Add stackable back to general display (no schema change needed)
 *
 * 2. charge_types: seed new period-benefit types
 *    (nutrition_service, personal_training, duet_personal_training, group_class)
 *
 * 3. promotion_period_benefits: drop and recreate with new shape
 *    Old: membership_plan_id + action_type_id + value + duration_months
 *    New: charge_type_id + quantity + frequency_interval + frequency_unit + enabled
 */

const NEW_CHARGE_TYPES = [
  { code: 'nutrition_service',      name: 'Nutrition Service' },
  { code: 'personal_training',      name: 'Personal Training' },
  { code: 'duet_personal_training', name: 'Duet Personal Training' },
  { code: 'group_class',            name: 'Group Class' },
];

exports.up = async (knex) => {
  // ── 1. promotions ──────────────────────────────────────────────────────────

  // Drop old status CHECK (may be named differently on older DBs)
  await knex.raw('ALTER TABLE promotions DROP CHECK promotions_status_check').catch(() => {});

  // Rename status → lifecycle_status
  const hasLifecycle = await knex.schema.hasColumn('promotions', 'lifecycle_status');
  if (!hasLifecycle) {
    await knex.schema.alterTable('promotions', (t) => {
      t.renameColumn('status', 'lifecycle_status');
    });
  }

  // New CHECK
  await knex.raw(
    "ALTER TABLE promotions DROP CONSTRAINT chk_promotions_lifecycle_status",
  ).catch(() => {});
  await knex.raw(
    "ALTER TABLE promotions ADD CONSTRAINT chk_promotions_lifecycle_status " +
    "CHECK (lifecycle_status IN ('active','inactive','deleted'))",
  );

  // Add soft-delete columns
  const hasDeletedAt = await knex.schema.hasColumn('promotions', 'deleted_at');
  if (!hasDeletedAt) {
    await knex.schema.alterTable('promotions', (t) => {
      t.datetime('deleted_at').nullable().after('created_at');
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .after('deleted_at');
    });
  }

  // Add free period columns
  const hasFreeperiod = await knex.schema.hasColumn('promotions', 'free_period_paid_months');
  if (!hasFreeperiod) {
    await knex.schema.alterTable('promotions', (t) => {
      t.integer('free_period_paid_months').unsigned().nullable().after('deleted_by_membership_id');
      t.integer('free_period_bonus_months').unsigned().nullable().after('free_period_paid_months');
    });
  }

  // ── 2. charge_types: seed new period-benefit types ─────────────────────────

  for (const { code, name } of NEW_CHARGE_TYPES) {
    const existing = await knex('charge_types').where({ code }).first();
    if (!existing) {
      await knex('charge_types').insert({ code, name, active: true, is_gym_charge: 0 });
    }
  }

  // ── 3. promotion_period_benefits ───────────────────────────────────────────

  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_positive_check').catch(() => {});
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_frequency_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotion_period_benefits');

  await knex.schema.createTable('promotion_period_benefits', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('promotion_id').unsigned().notNullable()
      .references('id').inTable('promotions').onDelete('CASCADE');
    t.integer('charge_type_id').unsigned().notNullable()
      .references('id').inTable('charge_types');
    t.integer('quantity').unsigned().notNullable();
    t.integer('frequency_interval').unsigned().notNullable();
    t.string('frequency_unit', 10).notNullable();
    t.tinyint('enabled').notNullable().defaultTo(1);
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['promotion_id'], 'ppb_promotion_idx');
  });

  await knex.raw(
    "ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_frequency_check " +
    "CHECK (frequency_unit IN ('week','month'))",
  );
  await knex.raw(
    "ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_positive_check " +
    "CHECK (quantity > 0 AND frequency_interval > 0)",
  );
};

exports.down = async (knex) => {
  // Drop promotion_period_benefits FIRST (holds FK → charge_types, must go before deletes)
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_positive_check').catch(() => {});
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_frequency_check').catch(() => {});
  await knex.schema.dropTableIfExists('promotion_period_benefits');

  // Now safe to remove the seeded charge types
  await knex('charge_types').whereIn('code', NEW_CHARGE_TYPES.map((c) => c.code)).delete();

  await knex.schema.createTable('promotion_period_benefits', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('promotion_id').unsigned().notNullable()
      .references('id').inTable('promotions').onDelete('CASCADE');
    t.integer('membership_plan_id').unsigned().notNullable()
      .references('id').inTable('membership_plans').onDelete('CASCADE');
    t.integer('action_type_id').unsigned().notNullable()
      .references('id').inTable('action_types');
    t.decimal('value', 10, 2).nullable();
    t.integer('duration_months').unsigned().notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['promotion_id'], 'ppb_promotion_index');
  });
  await knex.raw(
    "ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_positive_check " +
    "CHECK (duration_months > 0)",
  );

  // Revert promotions columns
  const hasFreeperiod = await knex.schema.hasColumn('promotions', 'free_period_paid_months');
  if (hasFreeperiod) {
    await knex.schema.alterTable('promotions', (t) => {
      t.dropColumn('free_period_bonus_months');
      t.dropColumn('free_period_paid_months');
    });
  }

  const hasDeletedAt = await knex.schema.hasColumn('promotions', 'deleted_at');
  if (hasDeletedAt) {
    await knex.raw('ALTER TABLE promotions DROP FOREIGN KEY `promotions_deleted_by_membership_id_foreign`').catch(() => {});
    await knex.schema.alterTable('promotions', (t) => {
      t.dropColumn('deleted_by_membership_id');
      t.dropColumn('deleted_at');
    });
  }

  // Rename lifecycle_status → status
  await knex.raw('ALTER TABLE promotions DROP CONSTRAINT chk_promotions_lifecycle_status').catch(() => {});
  const hasLifecycle = await knex.schema.hasColumn('promotions', 'lifecycle_status');
  if (hasLifecycle) {
    await knex.schema.alterTable('promotions', (t) => {
      t.renameColumn('lifecycle_status', 'status');
    });
  }
  await knex.raw(
    "ALTER TABLE promotions ADD CONSTRAINT promotions_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
};

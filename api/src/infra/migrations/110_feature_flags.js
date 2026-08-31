/**
 * #292: Feature Flags for System Navigation.
 *
 * 1. Makes audit_logs.gym_id nullable so platform-level audit rows (no gym
 *    context) can be written. The FK is preserved — NULL is allowed by MySQL
 *    FK semantics; it simply means "not scoped to a gym".
 *
 * 2. Creates the feature_flags table: one row per navigation node, keyed by
 *    a stable dot-separated identifier (e.g. "nutrition.nutrition_library").
 *    All existing, already-released navigation nodes are seeded as enabled=1.
 *    New, unreleased features should be inserted in their own migration with
 *    enabled=0 and will default to that value.
 */
exports.up = async (knex) => {
  // 1. Make audit_logs.gym_id nullable so platform audits can omit a gym.
  // MySQL allows modifying nullability on a FK column without dropping the FK.
  await knex.raw('ALTER TABLE audit_logs MODIFY COLUMN gym_id CHAR(36) NULL');

  // 2. Create feature_flags table.
  if (!(await knex.schema.hasTable('feature_flags'))) {
    await knex.schema.createTable('feature_flags', (t) => {
      t.increments('id').primary();
      t.string('feature_key', 100).notNullable().unique();
      t.tinyint('enabled').notNullable().defaultTo(0);
      t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
      t.string('updated_by_name', 255).nullable();
    });
    await knex.raw(
      'ALTER TABLE feature_flags ADD CONSTRAINT chk_feature_flags_enabled CHECK (enabled IN (0, 1))',
    );
  }

  // 3. Seed all currently-released navigation nodes as enabled=1.
  const released = [
    'membership',
    'membership.members',
    'calendar',
    'calendar.calendar',
    'organization',
    'organization.staff',
    'organization.centers',
    'organization.spaces',
    'organization.activity_types',
    'organization.class_packages',
    'training',
    'training.exercises',
    'training.workout_templates',
    'training.training_plan_templates',
    'training.training_plans',
    'nutrition',
    'nutrition.nutrition_library',
    'nutrition.nutrition_plan_templates',
    'nutrition.nutrition_plans',
    'payments',
    'payments.transactions',
    'financials',
    'financials.plans',
    'financials.promotions',
    'financials.gym_charges',
    'financials.payment_providers',
    'system',
    'system.audit',
    'system.themes',
    'system.recycle_bin',
  ];

  for (const feature_key of released) {
    await knex.raw(
      'INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, 1, UTC_TIMESTAMP())',
      [feature_key],
    );
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('feature_flags');
  // Purge platform-level audit rows (gym_id IS NULL) before restoring NOT NULL.
  // WARNING: destructive — those audit entries cannot be recovered.
  // Do not roll back this migration after platform audits have been written.
  await knex.raw('DELETE FROM audit_logs WHERE gym_id IS NULL');
  await knex.raw('ALTER TABLE audit_logs MODIFY COLUMN gym_id CHAR(36) NOT NULL');
};

/**
 * #70: Create plan_allowances — replaces class_type_user_memberships for booking access.
 * Supports unlimited and session_count (with recurrence window) per activity type.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('plan_allowances'))) {
    await knex.schema.createTable('plan_allowances', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36) collate utf8mb4_unicode_ci').notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable().references('id').inTable('membership_plans').onDelete('CASCADE');
      t.integer('activity_type_id').unsigned().notNullable().references('id').inTable('activity_types').onDelete('CASCADE');
      t.enum('allowance_type', ['unlimited', 'session_count']).notNullable().defaultTo('unlimited');
      t.integer('session_count').unsigned().nullable();
      t.integer('recurrence_interval').unsigned().nullable();
      t.enum('recurrence_unit', ['day', 'week', 'month', 'year']).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['membership_plan_id', 'activity_type_id']);
    });

    // Migrate existing class_type_user_memberships → plan_allowances (unlimited)
    await knex.raw(`
      INSERT IGNORE INTO plan_allowances (gym_id, membership_plan_id, activity_type_id, allowance_type)
      SELECT ctum.gym_id, ctum.membership_plan_id, ctum.activity_type_id, 'unlimited'
      FROM class_type_user_memberships ctum
      WHERE ctum.activity_type_id IS NOT NULL
    `).catch(() => {});
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('plan_allowances');
};

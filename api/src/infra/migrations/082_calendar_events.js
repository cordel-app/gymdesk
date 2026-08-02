/**
 * #190: Calendar Events table — the core entity for the Calendar module.
 * Every scheduled occurrence is an independent row.
 */
exports.up = async (knex) => {
  await knex.schema.createTableIfNotExists('calendar_events', (t) => {
    t.increments('id').unsigned().primary();

    t.string('gym_id', 36).notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');

    t.string('title', 255).notNullable();

    t.integer('activity_type_id').unsigned().nullable()
      .references('id').inTable('activity_types').onDelete('SET NULL');

    t.integer('space_id').unsigned().nullable()
      .references('id').inTable('spaces').onDelete('SET NULL');

    t.integer('trainer_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');

    t.string('color', 7).nullable();

    t.datetime('starts_at').notNullable();
    t.datetime('ends_at').notNullable();
    t.tinyint('all_day').notNullable().defaultTo(0);

    t.text('description').nullable();

    t.string('status', 20).notNullable().defaultTo('scheduled');

    t.integer('created_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.integer('modified_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('deleted_at').nullable();
    t.integer('deleted_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');

    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    t.index(['gym_id', 'starts_at', 'ends_at'], 'calendar_events_gym_range_idx');
    t.index(['gym_id', 'space_id', 'starts_at', 'ends_at'], 'calendar_events_space_range_idx');
    t.index(['gym_id', 'trainer_membership_id', 'starts_at', 'ends_at'], 'calendar_events_trainer_range_idx');
  });

  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'calendar_events'
       AND CONSTRAINT_NAME = 'chk_calendar_events_status'`,
  );
  if (rows[0].cnt === 0) {
    await knex.raw(
      "ALTER TABLE calendar_events ADD CONSTRAINT chk_calendar_events_status " +
      "CHECK (status IN ('draft','scheduled','completed','cancelled'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE calendar_events DROP CHECK chk_calendar_events_status').catch(() => {});
  await knex.schema.dropTableIfExists('calendar_events');
};

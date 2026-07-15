/**
 * #59: Event — a one-off gym event distinct from recurring class_sessions
 * (open days, competitions, parties), scoped to a Center.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('events')) return;
  await knex.schema.createTable('events', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('center_id').unsigned().notNullable()
      .references('id').inTable('centers').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.text('description');
    t.integer('room_id').unsigned()
      .references('id').inTable('rooms').onDelete('SET NULL');
    t.datetime('starts_at').notNullable();
    t.datetime('ends_at').notNullable();
    t.integer('capacity').unsigned();
    t.string('status', 20).notNullable().defaultTo('scheduled');
    t.text('cancellation_reason');
    t.integer('created_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('modified_at');
    t.integer('modified_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('deleted_at');
    t.index(['gym_id', 'center_id', 'starts_at'], 'events_center_starts_index');
  });
  await knex.raw(
    "ALTER TABLE events ADD CONSTRAINT events_status_check " +
    "CHECK (status IN ('scheduled','cancelled','completed'))",
  );
  await knex.raw(
    "ALTER TABLE events ADD CONSTRAINT events_time_check CHECK (ends_at > starts_at)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE events DROP CHECK events_status_check').catch(() => {});
  await knex.raw('ALTER TABLE events DROP CHECK events_time_check').catch(() => {});
  await knex.schema.dropTableIfExists('events');
};

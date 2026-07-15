/**
 * #59: TrainerAvailability — per-trainer-per-center availability windows,
 * either recurring (weekday) or one-off (specific_date). trainer_membership_id
 * reuses the coach-role gym_memberships row, same as class_sessions.trainer_membership_id.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('trainer_availability')) return;
  await knex.schema.createTable('trainer_availability', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('center_id').unsigned().notNullable()
      .references('id').inTable('centers').onDelete('CASCADE');
    t.integer('trainer_membership_id').unsigned().notNullable()
      .references('id').inTable('gym_memberships').onDelete('CASCADE');
    t.boolean('is_recurring').notNullable().defaultTo(true);
    t.specificType('weekday', 'tinyint unsigned'); // 0=Sun..6=Sat, recurring only
    t.date('specific_date'); // one-off only
    t.time('starts_time').notNullable();
    t.time('ends_time').notNullable();
    t.text('notes');
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('modified_at');
    t.integer('modified_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('deleted_at');
    t.index(['gym_id', 'center_id', 'trainer_membership_id'], 'trainer_availability_lookup_index');
  });
  await knex.raw(
    "ALTER TABLE trainer_availability ADD CONSTRAINT trainer_availability_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
  await knex.raw(`
    ALTER TABLE trainer_availability ADD CONSTRAINT trainer_availability_shape_check CHECK (
      (is_recurring = 1 AND weekday IS NOT NULL AND specific_date IS NULL) OR
      (is_recurring = 0 AND specific_date IS NOT NULL AND weekday IS NULL)
    )
  `);
  await knex.raw(
    "ALTER TABLE trainer_availability ADD CONSTRAINT trainer_availability_time_check " +
    "CHECK (ends_time > starts_time)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE trainer_availability DROP CHECK trainer_availability_status_check').catch(() => {});
  await knex.raw('ALTER TABLE trainer_availability DROP CHECK trainer_availability_shape_check').catch(() => {});
  await knex.raw('ALTER TABLE trainer_availability DROP CHECK trainer_availability_time_check').catch(() => {});
  await knex.schema.dropTableIfExists('trainer_availability');
};

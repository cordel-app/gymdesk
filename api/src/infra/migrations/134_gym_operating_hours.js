/**
 * #418: Operating Hours & Holidays.
 *
 * gym_operating_hours — recurring weekly service hours, one row per shift
 * (so split shifts, e.g. Mon 09:00-14:00 + Mon 15:00-20:00, are just two rows
 * for the same weekday rather than a JSON blob). weekday: 0=Sun..6=Sat,
 * matching the convention already used by activity_type_schedule_rules and
 * trainer_availability.
 *
 * gym_holiday_hours — date-range exceptions that override the weekly hours
 * for specific dates (full closures via is_closed=1, or special hours via
 * start_time/end_time). annual_renewal marks a holiday to be matched by
 * month/day every year (resolved in application code, not pre-expanded here).
 *
 * Both tables are gym-wide (no center scoping) — the ticket describes a
 * single operating-hours schedule per gym, not per-center. Overnight shifts
 * (closing past midnight) aren't representable, same limitation as
 * trainer_availability — model them as two rows split at midnight.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('gym_operating_hours'))) {
    await knex.schema.createTable('gym_operating_hours', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.specificType('weekday', 'tinyint unsigned').notNullable();
      t.time('start_time').notNullable();
      t.time('end_time').notNullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('modified_at');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at');
      t.integer('deleted_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.index(['gym_id', 'weekday'], 'gym_operating_hours_lookup_index');
    });
  }
  await knex.raw('ALTER TABLE gym_operating_hours DROP CHECK chk_goh_weekday').catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_operating_hours ADD CONSTRAINT chk_goh_weekday CHECK (weekday BETWEEN 0 AND 6)',
  );
  await knex.raw('ALTER TABLE gym_operating_hours DROP CHECK chk_goh_time').catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_operating_hours ADD CONSTRAINT chk_goh_time CHECK (end_time > start_time)',
  );

  if (!(await knex.schema.hasTable('gym_holiday_hours'))) {
    await knex.schema.createTable('gym_holiday_hours', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.date('date_start').notNullable();
      t.date('date_end').notNullable();
      t.time('start_time');
      t.time('end_time');
      t.specificType('is_closed', 'tinyint').notNullable().defaultTo(0);
      t.specificType('annual_renewal', 'tinyint').notNullable().defaultTo(0);
      t.string('label', 255);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('modified_at');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at');
      t.integer('deleted_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.index(['gym_id', 'date_start', 'date_end'], 'gym_holiday_hours_lookup_index');
    });
  }
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_date').catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_holiday_hours ADD CONSTRAINT chk_ghh_date CHECK (date_end >= date_start)',
  );
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_shape').catch(() => {});
  await knex.raw(`
    ALTER TABLE gym_holiday_hours ADD CONSTRAINT chk_ghh_shape CHECK (
      (is_closed = 1 AND start_time IS NULL AND end_time IS NULL) OR
      (is_closed = 0 AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    )
  `);
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_is_closed').catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_holiday_hours ADD CONSTRAINT chk_ghh_is_closed CHECK (is_closed IN (0, 1))',
  );
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_annual_renewal').catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_holiday_hours ADD CONSTRAINT chk_ghh_annual_renewal CHECK (annual_renewal IN (0, 1))',
  );

  // Seed the nav/feature flag as released (this migration ships the whole feature).
  await knex.raw(
    "INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES ('calendar.operating_hours', 1, UTC_TIMESTAMP())",
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'calendar.operating_hours'");

  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_annual_renewal').catch(() => {});
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_is_closed').catch(() => {});
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_shape').catch(() => {});
  await knex.raw('ALTER TABLE gym_holiday_hours DROP CHECK chk_ghh_date').catch(() => {});
  await knex.schema.dropTableIfExists('gym_holiday_hours');

  await knex.raw('ALTER TABLE gym_operating_hours DROP CHECK chk_goh_time').catch(() => {});
  await knex.raw('ALTER TABLE gym_operating_hours DROP CHECK chk_goh_weekday').catch(() => {});
  await knex.schema.dropTableIfExists('gym_operating_hours');
};

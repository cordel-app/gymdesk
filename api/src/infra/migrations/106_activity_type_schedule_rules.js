/**
 * #269: New activity_type_schedule_rules table.
 * Stores one-off, weekly, and monthly recurrence rules per activity type.
 * Weekly rules: one row per weekday (e.g. Mon + Thu = 2 rows).
 * Monthly rules: one row with weekday + ordinal (e.g. "second Tuesday").
 * One-off rules: start_date is the occurrence date; end_date is null.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('activity_type_schedule_rules')) return;

  await knex.schema.createTable('activity_type_schedule_rules', (t) => {
    t.increments('id').unsigned().primary();

    t.string('gym_id', 36).notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');

    t.integer('activity_type_id').unsigned().notNullable()
      .references('id').inTable('activity_types').onDelete('CASCADE');

    t.string('type', 20).notNullable();

    // start_date: first possible occurrence date (required for weekly/monthly)
    // For one_off this IS the occurrence date
    t.date('start_date').notNullable();

    // end_date: last possible occurrence date (null for one_off)
    t.date('end_date').nullable();

    // 0=Sun, 1=Mon, …, 6=Sat. Used by weekly (per-row) and monthly.
    t.tinyint('weekday').unsigned().nullable();

    // first / second / third / fourth / fifth / last (monthly only)
    t.string('ordinal', 10).nullable();

    t.time('start_time').notNullable();
    t.time('end_time').notNullable();

    t.datetime('created_at').notNullable().defaultTo(knex.raw('UTC_TIMESTAMP()'));

    t.index(['gym_id', 'activity_type_id'], 'atsr_gym_activity_idx');
  });

  const [chkRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_atsr_type'",
  );
  if (chkRows.length === 0) {
    await knex.raw(
      "ALTER TABLE activity_type_schedule_rules ADD CONSTRAINT chk_atsr_type CHECK (type IN ('one_off','weekly','monthly'))",
    );
  }

  const [ordRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_atsr_ordinal'",
  );
  if (ordRows.length === 0) {
    await knex.raw(
      "ALTER TABLE activity_type_schedule_rules ADD CONSTRAINT chk_atsr_ordinal CHECK (ordinal IS NULL OR ordinal IN ('first','second','third','fourth','fifth','last'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE activity_type_schedule_rules DROP CHECK chk_atsr_ordinal').catch(() => {});
  await knex.raw('ALTER TABLE activity_type_schedule_rules DROP CHECK chk_atsr_type').catch(() => {});
  await knex.schema.dropTableIfExists('activity_type_schedule_rules');
};

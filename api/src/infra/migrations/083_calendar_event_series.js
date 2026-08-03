/**
 * #191: calendar_event_series — recurrence template for recurring Calendar Events.
 * Each row defines the pattern; individual occurrences live in calendar_events with series_id.
 */
exports.up = async (knex) => {
  await knex.schema.createTableIfNotExists('calendar_event_series', (t) => {
    t.increments('id').unsigned().primary();

    t.string('gym_id', 36).notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');

    // Event template — mirrored to each generated occurrence
    t.string('title', 255).notNullable();
    t.integer('activity_type_id').unsigned().nullable()
      .references('id').inTable('activity_types').onDelete('SET NULL');
    t.integer('space_id').unsigned().nullable()
      .references('id').inTable('spaces').onDelete('SET NULL');
    t.integer('trainer_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.string('color', 7).nullable();
    t.text('description').nullable();

    // Timing template (start time + duration to compute ends_at for each occurrence)
    t.time('start_time').notNullable();
    t.integer('duration_minutes').unsigned().notNullable();

    // Recurrence pattern
    t.string('recurrence_type', 20).notNullable();
    t.tinyint('recurrence_interval').unsigned().notNullable().defaultTo(1);
    t.string('weekdays', 30).nullable();       // comma-separated: 'Mon,Wed,Fri'
    t.string('monthly_ordinal', 10).nullable(); // 'first'|'second'|'third'|'fourth'|'last'
    t.string('monthly_weekday', 3).nullable();  // 'Mon'|'Tue'|...|'Sun'

    // Series range
    t.date('series_start_date').notNullable();
    t.string('end_type', 20).notNullable().defaultTo('never');
    t.date('end_date').nullable();
    t.integer('end_count').unsigned().nullable();

    // Audit
    t.integer('created_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.integer('modified_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('updated_at').notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    t.datetime('deleted_at').nullable();

    t.index(['gym_id'], 'ces_gym_idx');
  });

  const [[{ cnt: cntType }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_series'
       AND CONSTRAINT_NAME = 'chk_ces_recurrence_type'`,
  );
  if (cntType === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_series ADD CONSTRAINT chk_ces_recurrence_type " +
      "CHECK (recurrence_type IN ('daily','weekdays','weekends','weekly','monthly','yearly'))",
    );
  }

  const [[{ cnt: cntEnd }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_series'
       AND CONSTRAINT_NAME = 'chk_ces_end_type'`,
  );
  if (cntEnd === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_series ADD CONSTRAINT chk_ces_end_type " +
      "CHECK (end_type IN ('never','on_date','after_n'))",
    );
  }

  const [[{ cnt: cntOrdinal }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_series'
       AND CONSTRAINT_NAME = 'chk_ces_monthly_ordinal'`,
  );
  if (cntOrdinal === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_series ADD CONSTRAINT chk_ces_monthly_ordinal " +
      "CHECK (monthly_ordinal IS NULL OR monthly_ordinal IN ('first','second','third','fourth','last'))",
    );
  }

  const [[{ cnt: cntWeekday }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_series'
       AND CONSTRAINT_NAME = 'chk_ces_monthly_weekday'`,
  );
  if (cntWeekday === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_series ADD CONSTRAINT chk_ces_monthly_weekday " +
      "CHECK (monthly_weekday IS NULL OR monthly_weekday IN ('Mon','Tue','Wed','Thu','Fri','Sat','Sun'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE calendar_event_series DROP CHECK chk_ces_recurrence_type').catch(() => {});
  await knex.raw('ALTER TABLE calendar_event_series DROP CHECK chk_ces_end_type').catch(() => {});
  await knex.raw('ALTER TABLE calendar_event_series DROP CHECK chk_ces_monthly_ordinal').catch(() => {});
  await knex.raw('ALTER TABLE calendar_event_series DROP CHECK chk_ces_monthly_weekday').catch(() => {});
  await knex.schema.dropTableIfExists('calendar_event_series');
};

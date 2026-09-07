/**
 * #360 stage 3 (API consolidation): close schema gaps left by stage 2 and add
 * the `kind` discriminator that lets classSessionsRouter and calendarEventsRouter
 * share the same calendar_events table.
 *
 * Changes:
 *   1. calendar_events.center_id        — FK to centers (was missing from stage 2)
 *   2. calendar_events.kind             — 'session'|'event', default 'event'
 *   3. calendar_event_bookings.center_id
 *   4. calendar_event_bookings.modified_at
 *   5. calendar_event_bookings.modified_by_membership_id
 *   6. calendar_event_shared_training_requests.calendar_event_id FK — fix to CASCADE
 *   7. class_package_transactions.calendar_event_booking_id — new FK to ceb
 *   8. class_package_transactions.booking_id — make nullable so new inserts can set it NULL
 *   9. Backfill: rows with schedule_rule_id → kind='session'
 *
 * Every step is guarded independently — DDL is non-transactional in MySQL.
 */

exports.up = async (knex) => {
  // 1. center_id on calendar_events
  if (!(await knex.schema.hasColumn('calendar_events', 'center_id'))) {
    await knex.schema.table('calendar_events', (t) => {
      t.integer('center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('SET NULL')
        .after('gym_id');
    });
  }

  // 2. kind on calendar_events
  if (!(await knex.schema.hasColumn('calendar_events', 'kind'))) {
    await knex.schema.table('calendar_events', (t) => {
      t.string('kind', 10).notNullable().defaultTo('event').after('center_id');
    });

    const [[{ cnt: cntKindChk }]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_events'
         AND CONSTRAINT_NAME = 'chk_ce_kind'`,
    );
    if (cntKindChk === 0) {
      await knex.raw(
        "ALTER TABLE calendar_events ADD CONSTRAINT chk_ce_kind CHECK (kind IN ('session','event'))",
      );
    }

    // Backfill: materialised sessions have a schedule_rule_id; hand-created sessions
    // (created via the class-sessions router before this migration) do not exist in
    // production yet (hard cutover — no prod data to preserve per decision in #360).
    await knex.raw(
      "UPDATE calendar_events SET kind = 'session' WHERE schedule_rule_id IS NOT NULL",
    );
  }

  // 3. center_id on calendar_event_bookings
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'center_id'))) {
    await knex.schema.table('calendar_event_bookings', (t) => {
      t.integer('center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('SET NULL');
    });
  }

  // 4. modified_at on calendar_event_bookings
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'modified_at'))) {
    await knex.schema.table('calendar_event_bookings', (t) => {
      t.datetime('modified_at').nullable();
    });
  }

  // 5. modified_by_membership_id on calendar_event_bookings
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'modified_by_membership_id'))) {
    await knex.schema.table('calendar_event_bookings', (t) => {
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_ceb_modified_by');
    });
  }

  // 6. Fix calendar_event_shared_training_requests.calendar_event_id FK to CASCADE.
  //    Migration 133 used RESTRICT (Knex default). Drop and recreate.
  const [[{ cnt: cntRestrictFk }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND REFERENCED_TABLE_NAME = 'calendar_events'
       AND DELETE_RULE = 'RESTRICT'`,
  );
  if (cntRestrictFk > 0) {
    await knex.raw(
      'ALTER TABLE calendar_event_shared_training_requests DROP FOREIGN KEY fk_cestr_event',
    );
    await knex.raw(
      `ALTER TABLE calendar_event_shared_training_requests
       ADD CONSTRAINT fk_cestr_event
       FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id) ON DELETE CASCADE`,
    );
  }

  // 7. calendar_event_booking_id on class_package_transactions
  if (!(await knex.schema.hasColumn('class_package_transactions', 'calendar_event_booking_id'))) {
    await knex.schema.table('class_package_transactions', (t) => {
      t.integer('calendar_event_booking_id').unsigned().nullable()
        .references('id').inTable('calendar_event_bookings').onDelete('SET NULL')
        .withKeyName('fk_cpt_ceb');
    });
  }

  // 8. Make class_package_transactions.booking_id nullable so new code can set it NULL.
  const [[{ IS_NULLABLE: bookingIdNullable }]] = await knex.raw(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'class_package_transactions'
       AND COLUMN_NAME = 'booking_id'`,
  );
  if (bookingIdNullable === 'NO') {
    await knex.raw(
      'ALTER TABLE class_package_transactions MODIFY COLUMN booking_id INT UNSIGNED NULL',
    );
  }
};

exports.down = async (knex) => {
  // Restore class_package_transactions
  if (await knex.schema.hasColumn('class_package_transactions', 'calendar_event_booking_id')) {
    await knex.raw('ALTER TABLE class_package_transactions DROP FOREIGN KEY fk_cpt_ceb');
    await knex.schema.table('class_package_transactions', (t) => {
      t.dropColumn('calendar_event_booking_id');
    });
  }

  // Restore calendar_event_bookings columns
  for (const col of ['modified_by_membership_id', 'modified_at', 'center_id']) {
    if (await knex.schema.hasColumn('calendar_event_bookings', col)) {
      if (col === 'modified_by_membership_id') {
        await knex.raw('ALTER TABLE calendar_event_bookings DROP FOREIGN KEY fk_ceb_modified_by');
      }
      await knex.schema.table('calendar_event_bookings', (t) => { t.dropColumn(col); });
    }
  }

  // Restore RESTRICT FK on calendar_event_shared_training_requests
  const [[{ cnt: cntCascadeFk }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND REFERENCED_TABLE_NAME = 'calendar_events'
       AND DELETE_RULE = 'CASCADE'`,
  );
  if (cntCascadeFk > 0) {
    await knex.raw(
      'ALTER TABLE calendar_event_shared_training_requests DROP FOREIGN KEY fk_cestr_event',
    );
    await knex.raw(
      `ALTER TABLE calendar_event_shared_training_requests
       ADD CONSTRAINT fk_cestr_event
       FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id)`,
    );
  }

  // Remove kind and center_id from calendar_events
  if (await knex.schema.hasColumn('calendar_events', 'kind')) {
    await knex.raw('ALTER TABLE calendar_events DROP CONSTRAINT chk_ce_kind');
    await knex.schema.table('calendar_events', (t) => { t.dropColumn('kind'); });
  }
  if (await knex.schema.hasColumn('calendar_events', 'center_id')) {
    await knex.schema.table('calendar_events', (t) => {
      t.dropForeign(['center_id']);
      t.dropColumn('center_id');
    });
  }
};

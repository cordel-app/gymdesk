/**
 * #360 stage 3 (API consolidation): closes the schema gaps identified while
 * scoping stage 3 (see issue #360 comment thread) before repointing
 * class-sessions.ts/calendar-events.ts/bookings.ts/me.ts/shared-training-requests.ts
 * at calendar_events/calendar_event_bookings/calendar_event_shared_training_requests.
 *
 * 1. calendar_events.kind ENUM('session','event') — the discriminator agreed
 *    in the issue thread. `class-sessions.ts` (manual creation) and the
 *    schedule-rule materializer (domain/scheduleEngine.ts) write 'session';
 *    `calendar-events.ts` writes 'event'. GET /class-sessions filters
 *    kind='session', GET /calendar-events filters kind='event' — this is what
 *    lets the admin Calendar page's existing dual-fetch (#326) keep rendering
 *    each occurrence exactly once. Existing rows materialized by a schedule
 *    rule are backfilled to 'session' (they're bookable class occurrences);
 *    every other existing row is a plain event, matching the column default.
 * 2. calendar_events.center_id — was never added despite docs/architecture.md
 *    assuming it existed; class_sessions.center_id is NOT NULL, so the
 *    equivalent column here is nullable at the schema level (a plain 'event'
 *    row is never center-scoped) but required at the application level for
 *    'session' rows, resolved the same way class-sessions.ts already does
 *    via resolveCenterId().
 * 3. calendar_event_bookings gains center_id/modified_at/modified_by_membership_id
 *    — the old `bookings` table has all three and attendance/cancel/refund
 *    code writes to them.
 * 4. calendar_event_shared_training_requests.calendar_event_id's FK is
 *    recreated with ON DELETE CASCADE, matching calendar_event_bookings
 *    (it had no explicit onDelete, defaulting to RESTRICT).
 * 5. class_package_transactions gains calendar_event_booking_id — its
 *    existing booking_id FK points at `bookings`, which package-credits.ts
 *    stops writing to once bookings move to calendar_event_bookings. Kept
 *    the legacy booking_id column/FK as-is (dead going forward, historical
 *    rows stay valid) rather than repointing it, since MySQL validates FK
 *    data on ALTER and there is no guaranteed id correspondence between the
 *    two tables.
 * 6. scheduleEngine.ts never set capacity on generated occurrences even
 *    though it already fetches activity_type.max_capacity — backfilled here
 *    for existing schedule-rule-materialized rows; the materializer itself
 *    is fixed in the same PR so newly generated occurrences get it going
 *    forward.
 *
 * Every step is guarded independently — DDL is non-transactional in MySQL,
 * so a retry after a partial failure must be able to resume from wherever it
 * stopped.
 */

exports.up = async (knex) => {
  // 1. calendar_events.kind
  if (!(await knex.schema.hasColumn('calendar_events', 'kind'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.string('kind', 10).notNullable().defaultTo('event').after('gym_id');
    });
  }
  const [[{ cnt: cntKindCheck }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_events'
       AND CONSTRAINT_NAME = 'chk_calendar_events_kind'`,
  );
  if (cntKindCheck === 0) {
    await knex.raw(
      "ALTER TABLE calendar_events ADD CONSTRAINT chk_calendar_events_kind " +
      "CHECK (kind IN ('session','event'))",
    );
  }
  await knex.raw(
    "UPDATE calendar_events SET kind = 'session' WHERE schedule_rule_id IS NOT NULL AND kind <> 'session'",
  );

  // 2. calendar_events.center_id
  if (!(await knex.schema.hasColumn('calendar_events', 'center_id'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.integer('center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('RESTRICT')
        .withKeyName('fk_calendar_events_center')
        .after('kind');
    });
  }

  // 6. backfill capacity on existing schedule-rule-materialized occurrences
  // (the materializer bug this closes — see scheduleEngine.ts).
  await knex.raw(`
    UPDATE calendar_events ce
    JOIN activity_types at ON at.id = ce.activity_type_id
    SET ce.capacity = at.max_capacity
    WHERE ce.schedule_rule_id IS NOT NULL AND ce.capacity IS NULL
  `);

  // 3. calendar_event_bookings additions
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'center_id'))) {
    await knex.schema.alterTable('calendar_event_bookings', (t) => {
      t.integer('center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('RESTRICT')
        .withKeyName('fk_ceb_center')
        .after('calendar_event_id');
    });
  }
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'modified_at'))) {
    await knex.schema.alterTable('calendar_event_bookings', (t) => {
      t.datetime('modified_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'modified_by_membership_id'))) {
    await knex.schema.alterTable('calendar_event_bookings', (t) => {
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_ceb_modified_by');
    });
  }

  // 4. calendar_event_shared_training_requests FK → CASCADE
  // Checked by DELETE_RULE, not just existence: a retry after a partial
  // failure (crash between the DROP and the re-ADD below) must not mistake
  // "constraint is gone entirely" for "already CASCADE" and skip repairing it.
  const [[cestrFk]] = await knex.raw(
    `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND CONSTRAINT_NAME = 'fk_cestr_event'`,
  );
  if (!cestrFk || cestrFk.DELETE_RULE !== 'CASCADE') {
    if (cestrFk) {
      await knex.raw('ALTER TABLE calendar_event_shared_training_requests DROP FOREIGN KEY fk_cestr_event');
    }
    await knex.raw(
      'ALTER TABLE calendar_event_shared_training_requests ' +
      'ADD CONSTRAINT fk_cestr_event FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id) ON DELETE CASCADE',
    );
  }

  // 5. class_package_transactions.calendar_event_booking_id
  if (!(await knex.schema.hasColumn('class_package_transactions', 'calendar_event_booking_id'))) {
    await knex.schema.alterTable('class_package_transactions', (t) => {
      t.integer('calendar_event_booking_id').unsigned().nullable()
        .references('id').inTable('calendar_event_bookings').onDelete('SET NULL')
        .withKeyName('fk_cpt_calendar_event_booking');
    });
  }
  // At most one of the legacy (bookings) and new (calendar_event_bookings)
  // booking references should ever be set on the same ledger row.
  const [[{ cnt: cntSingleBookingCheck }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'class_package_transactions'
       AND CONSTRAINT_NAME = 'chk_cpt_single_booking_ref'`,
  );
  if (cntSingleBookingCheck === 0) {
    await knex.raw(
      "ALTER TABLE class_package_transactions ADD CONSTRAINT chk_cpt_single_booking_ref " +
      "CHECK (booking_id IS NULL OR calendar_event_booking_id IS NULL)",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE class_package_transactions DROP CHECK chk_cpt_single_booking_ref').catch(() => {});
  if (await knex.schema.hasColumn('class_package_transactions', 'calendar_event_booking_id')) {
    await knex.raw('ALTER TABLE class_package_transactions DROP FOREIGN KEY fk_cpt_calendar_event_booking').catch(() => {});
    await knex.schema.alterTable('class_package_transactions', (t) => t.dropColumn('calendar_event_booking_id'));
  }

  // Mirror-image of the up() guard: repair to a plain (RESTRICT) FK whenever
  // the constraint is either missing or still the CASCADE this migration added.
  const [[cestrFk]] = await knex.raw(
    `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND CONSTRAINT_NAME = 'fk_cestr_event'`,
  );
  if (!cestrFk || cestrFk.DELETE_RULE === 'CASCADE') {
    if (cestrFk) {
      await knex.raw('ALTER TABLE calendar_event_shared_training_requests DROP FOREIGN KEY fk_cestr_event');
    }
    await knex.raw(
      'ALTER TABLE calendar_event_shared_training_requests ' +
      'ADD CONSTRAINT fk_cestr_event FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id)',
    );
  }

  if (await knex.schema.hasColumn('calendar_event_bookings', 'modified_by_membership_id')) {
    await knex.raw('ALTER TABLE calendar_event_bookings DROP FOREIGN KEY fk_ceb_modified_by').catch(() => {});
    await knex.schema.alterTable('calendar_event_bookings', (t) => t.dropColumn('modified_by_membership_id'));
  }
  if (await knex.schema.hasColumn('calendar_event_bookings', 'modified_at')) {
    await knex.schema.alterTable('calendar_event_bookings', (t) => t.dropColumn('modified_at'));
  }
  if (await knex.schema.hasColumn('calendar_event_bookings', 'center_id')) {
    await knex.raw('ALTER TABLE calendar_event_bookings DROP FOREIGN KEY fk_ceb_center').catch(() => {});
    await knex.schema.alterTable('calendar_event_bookings', (t) => t.dropColumn('center_id'));
  }

  if (await knex.schema.hasColumn('calendar_events', 'center_id')) {
    await knex.raw('ALTER TABLE calendar_events DROP FOREIGN KEY fk_calendar_events_center').catch(() => {});
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('center_id'));
  }

  await knex.raw('ALTER TABLE calendar_events DROP CHECK chk_calendar_events_kind').catch(() => {});
  if (await knex.schema.hasColumn('calendar_events', 'kind')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('kind'));
  }
};

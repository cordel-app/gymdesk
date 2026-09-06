/**
 * #360 stage 2 (schema): calendar_event_bookings — the unified booking table
 * for calendar_events, replacing `bookings` (which is scoped to
 * class_sessions). See docs/architecture.md's "Planned: CalendarEvent
 * Unification" section and docs/decisions.md #10.
 *
 * Mirrors the shape `bookings` grew across #17/#193/#372 (waitlist,
 * attendance, package-credit reference) so the booking/waitlist/attendance
 * logic can move over in a later stage with no behavior change. The
 * generated active_booking_key + unique index reproduces the "one
 * non-cancelled booking per member per occurrence" invariant from
 * 014_bookings_v2.js — MySQL has no partial unique indexes, so cancelled
 * rows are exempted via NULL (NULLs don't collide in unique indexes).
 *
 * This migration is schema-only. `bookings`/`class_sessions` are untouched
 * and continue to serve all booking traffic until the API consolidation
 * stage points routers at this table.
 *
 * Every step below is guarded independently (not just a single hasTable
 * check up front) — DDL is non-transactional in MySQL, so a retry after a
 * partial failure must be able to pick up from wherever it stopped.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('calendar_event_bookings'))) {
    await knex.schema.createTable('calendar_event_bookings', (t) => {
      t.increments('id').unsigned().primary();

      t.string('gym_id', 36).notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');

      t.integer('calendar_event_id').unsigned().notNullable()
        .references('id').inTable('calendar_events').onDelete('CASCADE');

      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');

      t.string('status', 20).notNullable().defaultTo('booked');
      t.integer('waitlist_position').unsigned().nullable();
      t.datetime('booked_at').nullable();
      t.datetime('waitlisted_at').nullable();
      t.datetime('cancelled_at').nullable();

      t.string('attendance_status', 20).notNullable().defaultTo('pending');
      t.datetime('attendance_recorded_at').nullable();
      t.integer('attendance_recorded_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_ceb_attendance_recorded_by');

      t.integer('user_class_package_id').unsigned().nullable()
        .references('id').inTable('user_class_packages').onDelete('SET NULL');

      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

      t.index(['gym_id', 'calendar_event_id'], 'ceb_gym_event_idx');
      t.index(['gym_id', 'member_id'], 'ceb_gym_member_idx');
    });
  }

  const [[{ cnt: cntStatusCheck }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_bookings'
       AND CONSTRAINT_NAME = 'chk_ceb_status'`,
  );
  if (cntStatusCheck === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_bookings ADD CONSTRAINT chk_ceb_status " +
      "CHECK (status IN ('booked','waitlisted','cancelled'))",
    );
  }

  const [[{ cnt: cntAttendanceCheck }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_bookings'
       AND CONSTRAINT_NAME = 'chk_ceb_attendance_status'`,
  );
  if (cntAttendanceCheck === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_bookings ADD CONSTRAINT chk_ceb_attendance_status " +
      "CHECK (attendance_status IN ('pending','present','absent'))",
    );
  }

  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'active_booking_key'))) {
    // VIRTUAL, not STORED — a STORED column referencing an FK column trips
    // MySQL 8.4/HeatWave with a misleading FK error (see 007's note).
    await knex.raw(
      "ALTER TABLE calendar_event_bookings " +
      "ADD COLUMN active_booking_key INT UNSIGNED " +
      "GENERATED ALWAYS AS (IF(status <> 'cancelled', member_id, NULL)) VIRTUAL",
    );
  }

  const [indexRows] = await knex.raw(
    "SHOW INDEX FROM calendar_event_bookings WHERE Key_name = 'ceb_event_active_unique'",
  );
  if (indexRows.length === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_bookings ADD UNIQUE KEY ceb_event_active_unique (calendar_event_id, active_booking_key)",
    );
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('calendar_event_bookings');
};

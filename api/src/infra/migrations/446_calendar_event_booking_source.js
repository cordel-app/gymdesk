/**
 * #3090 stage 1 — how a calendar event was created.
 *
 * calendar_events.booking_source is `manual` (staff or a member booked it) or `recurring_slot` (generated from a
 * Professional Services Schedule, written from stage 2). NOT NULL DEFAULT 'manual', so every existing row and every
 * writer that does not name it reads as manual. Additive and safe to re-run; mirrors BOOKING_SOURCES in
 * api/src/domain/bookingSource.ts.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('calendar_events', 'booking_source'))) {
    await knex.raw("ALTER TABLE calendar_events ADD COLUMN booking_source VARCHAR(20) NOT NULL DEFAULT 'manual'");
    await knex.raw(
      "ALTER TABLE calendar_events ADD CONSTRAINT chk_calendar_events_booking_source CHECK (booking_source IN ('manual','recurring_slot'))",
    );
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('calendar_events', 'booking_source')) {
    await knex.raw('ALTER TABLE calendar_events DROP CONSTRAINT chk_calendar_events_booking_source');
    await knex.raw('ALTER TABLE calendar_events DROP COLUMN booking_source');
  }
};

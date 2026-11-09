/**
 * #2559: a manually created calendar event has an event type — Public,
 * Private or Professional Services Based. Nullable with no backfill: NULL is
 * every event written before the ticket (the Admin reads one that names a
 * Professional Service as Professional Services Based, anything else as
 * Public). The CHECK mirrors CALENDAR_EVENT_TYPES in
 * api/src/domain/calendarEventType.ts.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE calendar_events ADD COLUMN event_type VARCHAR(30) NULL');
  await knex.raw(
    `ALTER TABLE calendar_events ADD CONSTRAINT chk_calendar_events_event_type
       CHECK (event_type IS NULL OR event_type IN ('public','private','professional_services'))`);
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE calendar_events DROP CONSTRAINT chk_calendar_events_event_type');
  await knex.raw('ALTER TABLE calendar_events DROP COLUMN event_type');
};

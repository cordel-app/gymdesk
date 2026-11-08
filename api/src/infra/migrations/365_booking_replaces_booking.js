/**
 * #1984 stage 2b-3: a replacement attendee. `replaces_booking_id` on the
 * replacement's `calendar_event_bookings` row names the booking of the original
 * participant it stands in for. NULL for every existing booking. The FK is
 * SET NULL so deleting the original never blocks. Re-entrant.
 */
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_bookings' AND COLUMN_NAME = 'replaces_booking_id' LIMIT 1`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw(
    `ALTER TABLE calendar_event_bookings
       ADD COLUMN replaces_booking_id INT UNSIGNED NULL,
       ADD CONSTRAINT fk_ceb_replaces_booking FOREIGN KEY (replaces_booking_id)
         REFERENCES calendar_event_bookings (id) ON DELETE SET NULL`);
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex))) return;
  await knex.raw('ALTER TABLE calendar_event_bookings DROP FOREIGN KEY fk_ceb_replaces_booking, DROP COLUMN replaces_booking_id');
};

/**
 * #1986 — a staff member booked a Member onto an event the Member holds no
 * Professional Service balance for, and accepted that the balance goes
 * negative. The flag is read when the session is spent (attendance, no-show,
 * late cancellation): with nothing left to spend, a booking carrying it takes
 * the session from its chosen service as a debt instead of spending nothing.
 * 0 (every booking written before, and any booking that was covered) keeps the
 * rule that a spend never goes below zero.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'negative_balance_ok'))) {
    await knex.raw('ALTER TABLE calendar_event_bookings ADD COLUMN negative_balance_ok TINYINT(1) NOT NULL DEFAULT 0');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('calendar_event_bookings', 'negative_balance_ok')) {
    await knex.raw('ALTER TABLE calendar_event_bookings DROP COLUMN negative_balance_ok');
  }
};

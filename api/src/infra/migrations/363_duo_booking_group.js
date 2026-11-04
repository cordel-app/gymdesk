/**
 * #1984 stage 2b-1: a Duo booking is one unit. Each participant stays one
 * `calendar_event_bookings` row; `booking_group_id` ties the two together and
 * `booked_by_member_id` records who made the booking. Both are NULL for every
 * existing (solo) booking. Also adds the `booking_cancelled_by_partner` alert
 * type to `chk_member_notifications_type` (superset of migration 270's list).
 * Re-entrant: each step checks before acting.
 */
const NOTIFICATION_CHECK = 'chk_member_notifications_type';
const NEW_TYPE = 'booking_cancelled_by_partner';
const NOTIFICATION_TYPES = [
  'booking_confirmed',
  'waitlist_joined',
  'promoted_from_waitlist',
  'event_cancelled',
  'event_updated',
  'booking_reminder_24h',
  'booking_reminder_1h',
  'shared_training_approved',
  'shared_training_rejected',
  'recurring_booking_skipped',
  'event_reactivated',
  'waitlist_closed',
  'waitlist_removed',
  'booking_reminder_2h',
  // #1391 — a message written by staff.
  'staff_message',
  // #1984 stage 2b-1 — the other participant of a Duo booking cancelled it.
  'booking_cancelled_by_partner',
];

const hasColumn = async (knex, column) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_bookings' AND COLUMN_NAME = ? LIMIT 1`, [column]);
  return rows.length > 0;
};

async function setNotificationCheck(knex, types) {
  const [[c]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_notifications' AND CONSTRAINT_NAME = ?`, [NOTIFICATION_CHECK]);
  const [[a]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ? AND CHECK_CLAUSE LIKE ?`,
    [NOTIFICATION_CHECK, `%${NEW_TYPE}%`]);
  const wanted = types.includes(NEW_TYPE);
  if (c.cnt > 0 && (a.cnt > 0) === wanted) return;
  if (c.cnt > 0) await knex.raw(`ALTER TABLE member_notifications DROP CHECK ${NOTIFICATION_CHECK}`);
  const values = types.map((t) => `'${t}'`).join(',');
  await knex.raw(`ALTER TABLE member_notifications ADD CONSTRAINT ${NOTIFICATION_CHECK} CHECK (type IN (${values}))`);
}

exports.up = async (knex) => {
  if (!(await hasColumn(knex, 'booking_group_id'))) {
    await knex.raw('ALTER TABLE calendar_event_bookings ADD COLUMN booking_group_id CHAR(36) NULL, ADD INDEX ceb_booking_group_idx (booking_group_id)');
  }
  if (!(await hasColumn(knex, 'booked_by_member_id'))) {
    await knex.raw('ALTER TABLE calendar_event_bookings ADD COLUMN booked_by_member_id INT UNSIGNED NULL');
  }
  await setNotificationCheck(knex, NOTIFICATION_TYPES);
};

exports.down = async (knex) => {
  let deleted;
  do {
    const [res] = await knex.raw(`DELETE FROM member_notifications WHERE type = '${NEW_TYPE}' LIMIT 5000`);
    deleted = res.affectedRows;
  } while (deleted === 5000);
  await setNotificationCheck(knex, NOTIFICATION_TYPES.filter((t) => t !== NEW_TYPE));
  if (await hasColumn(knex, 'booked_by_member_id')) await knex.raw('ALTER TABLE calendar_event_bookings DROP COLUMN booked_by_member_id');
  if (await hasColumn(knex, 'booking_group_id')) {
    await knex.raw('ALTER TABLE calendar_event_bookings DROP INDEX ceb_booking_group_idx, DROP COLUMN booking_group_id');
  }
};

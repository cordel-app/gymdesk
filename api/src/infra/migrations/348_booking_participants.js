/**
 * #1984 stage 2b — a member may book a place for a linked member beside their own.
 *
 *   calendar_event_bookings.booked_by_member_id
 *       NULL (every booking written before, and every booking a member made for
 *       themselves) means the participant booked it; a value that is not the
 *       booking's own member_id is the member who booked the place for them.
 *       Each participant is a booking row of their own, so capacity counts, the
 *       unique active booking, eligibility and the session ledger all keep
 *       working per person; this column only records who put them there.
 *   member_notifications.type 'participant_booked'
 *       The participant did not act, so this one is news to them (#1113 §4).
 *       Added to the CHECK beside the NotificationType union.
 *
 * Cost: the CHECK swap rebuilds member_notifications under ALGORITHM=COPY, as
 * 216/217/226/270 did, and the foreign key rebuilds calendar_event_bookings the
 * same way (a one-off cost on a table that is large but not hot overnight).
 * The tenant boundary is the router's: the FK carries no gym_id, so the writer
 * validates the participant against the caller's gym. `down` drops the column and the type; rows of the type
 * are an advisory log, so the rollback is lossy by design.
 */
const NOTIFICATION_CHECK = 'chk_member_notifications_type';
const NEW_TYPE = 'participant_booked';
// The CHECK's full list as this migration leaves it (migration 270's, plus the new type).
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
  'staff_message',
  'participant_booked',
];
const BASE_TYPES = NOTIFICATION_TYPES.filter((t) => t !== NEW_TYPE);

async function checkAllows(knex, value) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ? AND CHECK_CLAUSE LIKE ?`,
    [NOTIFICATION_CHECK, `%${value}%`],
  );
  return row.cnt > 0;
}

async function setNotificationCheck(knex, types) {
  const wanted = types.includes(NEW_TYPE);
  const [[exists]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_notifications' AND CONSTRAINT_NAME = ?`,
    [NOTIFICATION_CHECK],
  );
  if (exists.cnt > 0 && (await checkAllows(knex, NEW_TYPE)) === wanted) return;
  if (exists.cnt > 0) await knex.raw(`ALTER TABLE member_notifications DROP CHECK ${NOTIFICATION_CHECK}`);
  const values = types.map((t) => `'${t}'`).join(',');
  await knex.raw(
    `ALTER TABLE member_notifications ADD CONSTRAINT ${NOTIFICATION_CHECK} CHECK (type IN (${values}))`,
  );
}

async function fkExists(knex) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_bookings'
       AND CONSTRAINT_NAME = 'fk_ceb_booked_by_member'`,
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('calendar_event_bookings', 'booked_by_member_id'))) {
    await knex.raw('ALTER TABLE calendar_event_bookings ADD COLUMN booked_by_member_id INT UNSIGNED NULL');
  }
  if (!(await fkExists(knex))) {
    await knex.raw(
      'ALTER TABLE calendar_event_bookings ADD CONSTRAINT fk_ceb_booked_by_member FOREIGN KEY (booked_by_member_id) REFERENCES members (id) ON DELETE SET NULL',
    );
  }
  await setNotificationCheck(knex, NOTIFICATION_TYPES);
};

exports.down = async (knex) => {
  let deleted;
  do {
    const [res] = await knex.raw(`DELETE FROM member_notifications WHERE type = '${NEW_TYPE}' LIMIT 5000`);
    deleted = res.affectedRows;
  } while (deleted === 5000);
  await setNotificationCheck(knex, BASE_TYPES);
  if (await fkExists(knex)) await knex.raw('ALTER TABLE calendar_event_bookings DROP FOREIGN KEY fk_ceb_booked_by_member');
  if (await knex.schema.hasColumn('calendar_event_bookings', 'booked_by_member_id')) {
    await knex.raw('ALTER TABLE calendar_event_bookings DROP COLUMN booked_by_member_id');
  }
};

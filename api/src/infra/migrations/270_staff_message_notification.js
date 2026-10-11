/**
 * #1391 — `staff_message`, the alert a staff member sends by hand (a
 * communication to the members booked on an event), and the feature flag that
 * switches the capability on and off.
 *
 * `member_notifications.type` is governed by `chk_member_notifications_type`
 * (current definition before this: migration 226), and a new type goes in
 * **two** places — the `NotificationType` union and this constraint. MySQL has
 * no "add a value to a CHECK", so it is dropped and re-added wholesale with
 * migration 226's list plus one value. The new list is a strict superset, so
 * revalidation cannot fail on existing data. Helpers are copied from migration
 * 226 on purpose: a migration is never edited, so sharing one would let a later
 * change rewrite history that has already been applied.
 *
 * Cost: `ADD CONSTRAINT … CHECK` rebuilds `member_notifications` under
 * ALGORITHM=COPY, LOCK=SHARED (same maintenance window as 216/217/226).
 *
 * The flag `calendar.staff_communications` is seeded enabled, like every other
 * flag; a missing row already counts as enabled, so the row exists to make it
 * visible and switchable on Cordel → Feature Flags.
 */

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
];

const NOTIFICATION_CHECK = 'chk_member_notifications_type';
const NEW_TYPE = 'staff_message';
const FLAG_KEY = 'calendar.staff_communications';

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

async function checkAllows(knex, value) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?
       AND CHECK_CLAUSE LIKE ?`,
    [NOTIFICATION_CHECK, `%${value}%`],
  );
  return row.cnt > 0;
}

/** Swap the CHECK unless it is already right (also repairs a missing one). */
async function setNotificationCheck(knex, types) {
  const exists = await constraintExists(knex, 'member_notifications', NOTIFICATION_CHECK);
  const wanted = types.includes(NEW_TYPE);
  if (exists && (await checkAllows(knex, NEW_TYPE)) === wanted) return;
  if (exists) {
    await knex.raw(`ALTER TABLE member_notifications DROP CHECK ${NOTIFICATION_CHECK}`);
  }
  const values = types.map((t) => `'${t}'`).join(',');
  await knex.raw(
    `ALTER TABLE member_notifications ADD CONSTRAINT ${NOTIFICATION_CHECK} ` +
    `CHECK (type IN (${values}))`,
  );
}

exports.up = async (knex) => {
  await setNotificationCheck(knex, NOTIFICATION_TYPES);
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, modified_at)
     VALUES (?, 1, UTC_TIMESTAMP())`,
    [FLAG_KEY],
  );
};

exports.down = async (knex) => {
  await knex.raw('DELETE FROM feature_flags WHERE feature_key = ?', [FLAG_KEY]);
  // Rows of the dropped type would fail the narrower constraint; they are an
  // advisory log, so the rollback is lossy by design. Batched like 226's.
  let deleted;
  do {
    const [res] = await knex.raw(
      `DELETE FROM member_notifications WHERE type = '${NEW_TYPE}' LIMIT 5000`,
    );
    deleted = res.affectedRows;
  } while (deleted === 5000);
  await setNotificationCheck(knex, NOTIFICATION_TYPES.filter((t) => t !== NEW_TYPE));
};

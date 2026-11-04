/**
 * #2324 — `activity_discontinued`, the single alert a member gets when an
 * Activity is deactivated or deleted and its future events are cancelled.
 *
 * Same device as migration 270: `chk_member_notifications_type` is dropped and
 * re-added with the previous list (270's) plus one value (and 363's), a strict superset, so
 * revalidation cannot fail on existing data. Rebuilds `member_notifications`
 * under ALGORITHM=COPY, LOCK=SHARED. Helpers are copied, never shared.
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
  'staff_message',
  // #1984 stage 2b-1 (migration 363).
  'booking_cancelled_by_partner',
  // #2324 — the Activity was discontinued.
  'activity_discontinued',
];

const NOTIFICATION_CHECK = 'chk_member_notifications_type';
const NEW_TYPE = 'activity_discontinued';

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
};

exports.down = async (knex) => {
  let deleted;
  do {
    const [res] = await knex.raw(
      `DELETE FROM member_notifications WHERE type = '${NEW_TYPE}' LIMIT 5000`,
    );
    deleted = res.affectedRows;
  } while (deleted === 5000);
  await setNotificationCheck(knex, NOTIFICATION_TYPES.filter((t) => t !== NEW_TYPE));
};

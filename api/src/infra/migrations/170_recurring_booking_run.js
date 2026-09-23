/**
 * #647 stage 4: the nightly rolling 2-month booking window.
 *
 * Two small pieces of schema, no domain table of its own — the job reads
 * `member_recurring_slots` (migration 169) and writes through the ordinary
 * booking path.
 *
 * **1. `recurring_booking_run_log`** — the same single-row rate-limit singleton
 * `billing_run_log` (migration 111) is, for the same reason: `POST
 * /recurring-bookings/run` is triggered by an external scheduler (the thread's
 * Q4 answer: "it should be a daily activity at night"), and two runs firing at
 * once would walk the same members concurrently. Deliberate exception to the
 * `gym_id`-on-every-table rule: it is a system-wide singleton, not tenant data
 * — exactly the exception migration 111 already carved out.
 *
 * `last_run_at` is stamped when a full run *starts*, not when it finishes, so a
 * run that dies half way still holds the lock for its interval rather than
 * inviting a retry storm. Unlike billing, re-running is harmless (the job
 * creates only missing bookings and the projection skips what the Member
 * already holds), so the guard exists to stop overlap, not to protect money.
 *
 * **2. `chk_member_notifications_type`** — extended with
 * `recurring_booking_skipped`, the alert the job raises for a date it could not
 * book. Again from the thread's Q5 answer: "the night scheduler […] can publish
 * an alert into the membership app informing that the booking on May 1st could
 * not be completed because it is a festivity or the gym is closed or it was
 * already booked by another event."
 *
 * The constraint has to be dropped and re-added wholesale (MySQL has no "add a
 * value to a CHECK"), and while it is being rewritten two types that
 * `infra/notifications.ts` has been emitting since #575 are added to it as
 * well: `shared_training_approved` and `shared_training_rejected`. Migration
 * 087 predates them and nobody extended the CHECK, so every one of those
 * inserts has been failing with errno 3819 — invisibly, because
 * `sendNotification()` is fire-and-forget and only `console.error`s. Re-adding
 * the constraint without them would knowingly keep that broken, so they go in
 * here rather than waiting for a ticket of their own.
 *
 * **Cost — this one needs a maintenance window.** The CREATE TABLE is a single
 * empty row, but the CHECK swap is not the cheap metadata change it looks like.
 * Measured on MySQL 8.4: `DROP CHECK` accepts ALGORITHM=INPLACE, LOCK=NONE, but
 * `ADD CONSTRAINT … CHECK` accepts neither (errno 1845, then 1846) — MySQL
 * rebuilds the whole table with ALGORITHM=COPY under LOCK=SHARED. Reads carry
 * on; every *write* to `member_notifications` blocks until it finishes, and it
 * wants free disk of roughly the table plus its indexes. On a busy gym this log
 * is large, and because `sendNotification()` is fire-and-forget a blocked
 * insert does not fail a member's request — it holds one of the pool's ten
 * connections until the ALTER completes, so a long rebuild can stall unrelated
 * endpoints. Same class as migration 168's FK ALTER: run the two in the same
 * window, see `docs/go-to-production.md`. The new list is a strict superset of
 * the old one, so the revalidation cannot fail on data.
 *
 * Both statements are guarded so a re-run is a no-op rather than a second
 * rebuild — and so the constraint cannot go missing behind an already-created
 * table (migrations 168 and 169 have the same guard for the same reason: DDL
 * commits implicitly, and a `hasTable()` that has become true would skip a
 * block whose later statements never ran).
 */

const NOTIFICATION_TYPES = [
  // Migration 087 (#194) — booking lifecycle.
  'booking_confirmed',
  'waitlist_joined',
  'promoted_from_waitlist',
  'event_cancelled',
  'event_updated',
  'booking_reminder_24h',
  'booking_reminder_1h',
  // Emitted by `infra/notifications.ts` but never added to the CHECK — see header.
  'shared_training_approved',
  'shared_training_rejected',
  // #647 stage 4 — a recurring slot the nightly job could not book.
  'recurring_booking_skipped',
];

const NOTIFICATION_CHECK = 'chk_member_notifications_type';
/** The one value that tells this migration's list from the one before it. */
const STAGE_FOUR_TYPE = 'recurring_booking_skipped';

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

/** Does the live CHECK already list this value? */
async function notificationCheckAllows(knex, value) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?
       AND CHECK_CLAUSE LIKE ?`,
    [NOTIFICATION_CHECK, `%${value}%`],
  );
  return row.cnt > 0;
}

/**
 * Swap the type CHECK for the given list — but only when it is not already
 * right.
 *
 * `recurring_booking_skipped` is what tells the two lists apart, so its
 * presence in the live clause is the whole test, in both directions: `up()`
 * wants it there, `down()` wants it gone. MySQL renders `CHECK_CLAUSE` with
 * charset introducers (``(`type` in (_utf8mb4'booking_confirmed',…))``), which
 * is why this matches a substring rather than comparing the clause.
 *
 * Without the guard every `db:migrate` reaching this line would rebuild
 * `member_notifications` again (see the header on what that costs), and the
 * DROP would need a blind `.catch()` that would also swallow a metadata-lock
 * timeout — leaving the ADD to fail with a confusing errno 3822 instead.
 */
async function setNotificationCheck(knex, types) {
  const wanted = types.includes(STAGE_FOUR_TYPE);
  if ((await notificationCheckAllows(knex, STAGE_FOUR_TYPE)) === wanted) return;
  if (await constraintExists(knex, 'member_notifications', NOTIFICATION_CHECK)) {
    await knex.raw(`ALTER TABLE member_notifications DROP CHECK ${NOTIFICATION_CHECK}`);
  }
  const values = types.map((t) => `'${t}'`).join(',');
  await knex.raw(
    `ALTER TABLE member_notifications ADD CONSTRAINT ${NOTIFICATION_CHECK} ` +
    `CHECK (type IN (${values}))`,
  );
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('recurring_booking_run_log'))) {
    await knex.schema.createTable('recurring_booking_run_log', (t) => {
      t.specificType('id', 'TINYINT UNSIGNED').notNullable().defaultTo(1).primary();
      t.dateTime('last_run_at').nullable();
    });
  }
  // Each of these is guarded on its own rather than living inside the
  // hasTable() branch: CREATE TABLE commits implicitly, so a run that died
  // right after it would come back with hasTable() true, skip the branch and
  // record the migration as applied with the constraint — or the row the job
  // UPDATEs — missing for good.
  if (!(await constraintExists(knex, 'recurring_booking_run_log', 'chk_recurring_booking_run_log_id'))) {
    await knex.raw(
      'ALTER TABLE recurring_booking_run_log ADD CONSTRAINT chk_recurring_booking_run_log_id CHECK (id = 1)',
    );
  }
  await knex.raw('INSERT IGNORE INTO recurring_booking_run_log (id, last_run_at) VALUES (1, NULL)');

  await setNotificationCheck(knex, NOTIFICATION_TYPES);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('recurring_booking_run_log');

  // Drop stage 4's type from the CHECK, and its rows with it — they would fail
  // the narrower constraint, and they are an advisory log the job rebuilds on
  // its next run, not data anything else references.
  //
  // `shared_training_approved` / `shared_training_rejected` deliberately stay
  // in the restored list rather than reverting to migration 087's exact text:
  // rolling stage 4 back is no reason to re-break #575's notifications, and a
  // constraint that rejects what the running code writes would fail this very
  // ALTER as soon as one of those rows exists.
  // Batched: there is no index on `type`, so a single DELETE next-key-locks
  // every row of a log that is large by the time anyone rolls this back, in one
  // transaction and one undo/binlog entry.
  let deleted;
  do {
    const [res] = await knex.raw(
      `DELETE FROM member_notifications WHERE type = '${STAGE_FOUR_TYPE}' LIMIT 5000`,
    );
    deleted = res.affectedRows;
  } while (deleted === 5000);

  // Disable the nightly workflow before rolling back: a row the job inserts
  // between the DELETE above and the ADD below fails the ADD with errno 3819.
  // Re-running `down()` recovers, but the tidier order is to stop the job first.
  await setNotificationCheck(knex, NOTIFICATION_TYPES.filter((t) => t !== STAGE_FOUR_TYPE));
};

/**
 * #980 stage 2 — `waitlist_closed` and `waitlist_removed`, the two Members App
 * alerts a staff change to an occurrence's waiting list raises (§4, and the
 * thread's `Q2`: *"every update in the waitlist will be reflected in an alert
 * inside the members app"*).
 *
 * One CHECK swap and nothing else. `member_notifications.type` is governed by
 * `chk_member_notifications_type` (current definition: migration 216), and
 * CLAUDE.md's rule is that a new type goes in **two** places: the
 * `NotificationType` union in `api/src/infra/notifications.ts` *and* this
 * constraint. Adding only the union makes every insert of the type fail with
 * errno 3819 — invisibly, because `sendBulkNotification()` is fire-and-forget
 * and only `console.error`s, so a member whose place in the queue was removed
 * would simply never be told.
 *
 * Why two values rather than one: they are different promises to the member.
 * `waitlist_closed` says the list itself is gone (the gym disabled it), and
 * `waitlist_removed` says this one member was taken off a list that is still
 * open. Wording them the same would leave a member re-joining a queue that no
 * longer exists, or giving up on one they could still rejoin.
 *
 * MySQL has no "add a value to a CHECK", so the constraint is dropped and
 * re-added wholesale, and the list below is migration 216's plus two values —
 * which is also the `NotificationType` union verbatim, in the same order. That
 * is the invariant a future reader has to preserve: the CHECK is allowed to be
 * a superset (087 left three types nothing emits), never a subset.
 *
 * The three helpers below are copied from migration 216. That is deliberate,
 * not drift: a migration is never edited, so a shared helper would let a later
 * change rewrite history that has already been applied.
 *
 * **Cost — same maintenance window as migrations 170 and 216.** `DROP CHECK`
 * is INPLACE/LOCK=NONE, but `ADD CONSTRAINT … CHECK` is neither (errno 1845
 * then 1846): MySQL rebuilds `member_notifications` under ALGORITHM=COPY,
 * LOCK=SHARED. Reads carry on; every *write* blocks until it finishes, and a
 * blocked fire-and-forget insert holds one of the pool's ten connections
 * rather than failing a member's request, so on a large log a long rebuild can
 * stall unrelated endpoints. See `docs/go-to-production.md`.
 *
 * The new list is a strict superset of the old one, so revalidation cannot
 * fail on existing data. Guarded on the live clause so a re-run is a no-op
 * rather than a second rebuild.
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
  // #575 — shared training, added to the CHECK by migration 170.
  'shared_training_approved',
  'shared_training_rejected',
  // #647 stage 4 — a recurring slot the nightly job could not book.
  'recurring_booking_skipped',
  // #979 — a cancelled event put back on the calendar, with the member's
  // booking still on it.
  'event_reactivated',
  // #980 stage 2 — the occurrence's waiting list was disabled, taking every
  // member off it (§4/§5).
  'waitlist_closed',
  // #980 stage 2 — staff took this one member off a waiting list that is
  // still open.
  'waitlist_removed',
];

const NOTIFICATION_CHECK = 'chk_member_notifications_type';
/** The values that tell this migration's list from the one before it. */
const WAITLIST_TYPES = ['waitlist_closed', 'waitlist_removed'];
/** The one of them the guard below tests the live clause for. */
const GUARD_TYPE = 'waitlist_closed';

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

/**
 * Does the live CHECK already list this value?
 *
 * MySQL renders `CHECK_CLAUSE` with charset introducers
 * (``(`type` in (_utf8mb4'booking_confirmed',…))``), which is why this matches
 * a substring rather than comparing the clause.
 *
 * Note `waitlist_closed` is used as the guard value rather than
 * `waitlist_removed` for no reason beyond having to pick one — but it must be
 * a value no *earlier* list contains as a substring, which both of this
 * migration's are (migration 216's longest waitlist value is
 * `promoted_from_waitlist`, and neither of these is a substring of it).
 */
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
 * right. `waitlist_closed` is what tells the two lists apart, so its presence
 * in the live clause is the whole test, in both directions.
 *
 * Without that guard every `db:migrate` reaching this line would rebuild
 * `member_notifications` again, and the DROP would need a blind `.catch()`
 * that would also swallow a metadata-lock timeout.
 *
 * The **existence** check is part of the guard rather than only of the DROP.
 * DDL commits implicitly, so a run that died between the DROP and the ADD
 * comes back to a table with no constraint at all — and a guard that only
 * asked "does the clause mention this value" would read that as the narrow
 * list it wants and return without re-adding anything, leaving `type`
 * unconstrained for good. Asking both questions is also what makes a database
 * whose constraint went missing for any other reason repair itself on the next
 * migrate.
 */
async function setNotificationCheck(knex, types) {
  const wanted = types.includes(GUARD_TYPE);
  const exists = await constraintExists(knex, 'member_notifications', NOTIFICATION_CHECK);
  if (exists && (await notificationCheckAllows(knex, GUARD_TYPE)) === wanted) return;
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
  // Drop the two types from the CHECK, and their rows with them — they would
  // fail the narrower constraint, and they are an advisory log, not data
  // anything else references. Note the rollback is lossy by design: those
  // alerts are gone. The waiting-list rows those alerts were *about* are not
  // touched, because cancelling them was the staff action, not the alert.
  //
  // Batched because there is no index on `type`, so one unbounded DELETE would
  // scan and next-key-lock a log that is large by the time anyone rolls this
  // back, in a single statement that holds the server for minutes and
  // replicates as one event. It bounds each *statement*, not the transaction:
  // knex wraps a migration in one, so the locks and undo log still accumulate
  // across batches until the ALTER below implicitly commits them.
  //
  // Stop the API (or at least any waitlist edit) before rolling back: a row
  // inserted between the DELETE and the ADD fails the ADD with errno 3819.
  // Re-running `down()` then recovers — the guard above re-adds a constraint
  // that is missing rather than treating it as already narrow.
  for (const type of WAITLIST_TYPES) {
    let deleted;
    do {
      const [res] = await knex.raw(
        `DELETE FROM member_notifications WHERE type = '${type}' LIMIT 5000`,
      );
      deleted = res.affectedRows;
    } while (deleted === 5000);
  }

  await setNotificationCheck(
    knex,
    NOTIFICATION_TYPES.filter((t) => !WAITLIST_TYPES.includes(t)),
  );
};

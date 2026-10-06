/**
 * #1113 §2 — `booking_reminder_2h`, the pre-event training reminder the
 * scheduled run raises for a member who holds an active booking on an
 * occurrence starting within two hours.
 *
 * One CHECK swap plus one index. `member_notifications.type` is governed by
 * `chk_member_notifications_type` (current definition: migration 217), and
 * CLAUDE.md's rule is that a new type goes in **two** places: the
 * `NotificationType` union in `api/src/infra/notifications.ts` *and* this
 * constraint. Adding only the union makes every insert of the type fail with
 * errno 3819 — and here that failure would be *visible*, because the run awaits
 * its insert (`recordNotifications`) and reports what it wrote, which is the
 * difference between this alert and the fire-and-forget ones. It would still
 * mean no member is ever reminded, so the CHECK is not optional.
 *
 * **Why a third reminder value.** `booking_reminder_24h` and
 * `booking_reminder_1h` have been in this CHECK since migration 087 (#194) and
 * are written by nothing; their Members App copy reads *"Reminder: tomorrow"*
 * and *"Reminder: starting soon"*. Writing a two-hour reminder under either
 * would make the Alerts page say something other than §2 asks for, so this adds
 * a value and leaves those two exactly as they are — unwritten, not deleted.
 * The CHECK is allowed to be a superset of the union (migration 217's own note);
 * it must never be a subset.
 *
 * MySQL has no "add a value to a CHECK", so the constraint is dropped and
 * re-added wholesale, and the list below is migration 217's plus one value —
 * which is also the `NotificationType` union verbatim, in the same order.
 *
 * **The index is the other half of §5.** The run's duplicate prevention is a
 * `NOT EXISTS` on `(gym_id, member_id, type, entity_type, entity_id)` and it
 * runs every few minutes across every gym; migration 087's only index is
 * `(gym_id, member_id, created_at)`, which narrows to the member and then scans
 * their whole alert history. `mn_reminder_dedupe_idx` makes that lookup exact.
 * It is created here rather than in a migration of its own because the CHECK
 * swap below already rebuilds the table.
 *
 * The three helpers below are copied from migration 217. That is deliberate,
 * not drift: a migration is never edited, so a shared helper would let a later
 * change rewrite history that has already been applied.
 *
 * **Cost — same maintenance window as migrations 170, 216 and 217.** `DROP
 * CHECK` is INPLACE/LOCK=NONE, but `ADD CONSTRAINT … CHECK` is neither (errno
 * 1845 then 1846): MySQL rebuilds `member_notifications` under
 * ALGORITHM=COPY, LOCK=SHARED. Reads carry on; every *write* blocks until it
 * finishes, and a blocked fire-and-forget insert holds one of the pool's ten
 * connections rather than failing a member's request, so on a large log a long
 * rebuild can stall unrelated endpoints. See `docs/go-to-production.md`.
 *
 * The new list is a strict superset of the old one, so revalidation cannot fail
 * on existing data. Guarded on the live clause so a re-run is a no-op rather
 * than a second rebuild.
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
  // #1113 §2 — the pre-event training reminder (two hours before the start).
  'booking_reminder_2h',
];

const NOTIFICATION_CHECK = 'chk_member_notifications_type';
/** The one value that tells this migration's list from the one before it. */
const REMINDER_TYPE = 'booking_reminder_2h';
const DEDUPE_INDEX = 'mn_reminder_dedupe_idx';

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
 * The `_` characters in the value are single-character LIKE wildcards, so this
 * really asks for `booking` + any character + `reminder` + any character +
 * `2h`. Looser than the substring it reads as, and kept for consistency with
 * migrations 170, 216 and 217, whose helper this is copied from — it matches
 * none of the other twelve values, and in particular not the `24h`/`1h`
 * reminders, whose names end differently.
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
 * right. The one value this migration adds is what tells its list from
 * migration 217's, so its presence in the live clause is the whole test, in
 * both directions.
 *
 * The **existence** check is part of the guard rather than only of the DROP:
 * DDL commits implicitly, so a run that died between the DROP and the ADD comes
 * back to a table with no constraint at all, and a guard that only asked "does
 * the clause mention this value" would read that as the narrow list it wants
 * and return without re-adding anything, leaving `type` unconstrained for good.
 */
async function setNotificationCheck(knex, types) {
  const exists = await constraintExists(knex, 'member_notifications', NOTIFICATION_CHECK);
  const wanted = types.includes(REMINDER_TYPE);
  const correct = exists && (await notificationCheckAllows(knex, REMINDER_TYPE)) === wanted;
  if (correct) return;
  if (exists) {
    await knex.raw(`ALTER TABLE member_notifications DROP CHECK ${NOTIFICATION_CHECK}`);
  }
  const values = types.map((t) => `'${t}'`).join(',');
  await knex.raw(
    `ALTER TABLE member_notifications ADD CONSTRAINT ${NOTIFICATION_CHECK} ` +
    `CHECK (type IN (${values}))`,
  );
}

async function indexExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  await setNotificationCheck(knex, NOTIFICATION_TYPES);

  // The run's dedupe lookup, exactly. `member_id` last because the three
  // columns before it are equality-matched for one occurrence and the member is
  // what the subquery then probes for.
  if (!(await indexExists(knex, 'member_notifications', DEDUPE_INDEX))) {
    await knex.raw(
      `CREATE INDEX ${DEDUPE_INDEX} ON member_notifications ` +
      '(gym_id, type, entity_type, entity_id, member_id)',
    );
  }
};

exports.down = async (knex) => {
  if (await indexExists(knex, 'member_notifications', DEDUPE_INDEX)) {
    await knex.raw(`DROP INDEX ${DEDUPE_INDEX} ON member_notifications`);
  }

  // Drop the type from the CHECK, and its rows with it — they would fail the
  // narrower constraint, and they are an advisory log, not data anything else
  // references. The rollback is lossy by design: those reminders are gone. The
  // bookings they were about are untouched, and the next run after a roll
  // *forward* would simply raise them again for any event still in the window.
  //
  // Batched because `type` is the second column of the index above and that
  // index is dropped by the time this runs, so one unbounded DELETE would scan
  // and next-key-lock a log that is large by the time anyone rolls this back,
  // in a single statement that holds the server for minutes and replicates as
  // one event. It bounds each *statement*, not the transaction: knex wraps a
  // migration in one, so locks and undo log still accumulate across batches
  // until the ALTER below implicitly commits them.
  //
  // Stop the reminder run (or the API) before rolling back: a row inserted
  // between the DELETE and the ADD fails the ADD with errno 3819. Re-running
  // `down()` then recovers — the guard above re-adds a constraint that is
  // missing rather than treating it as already narrow.
  let deleted;
  do {
    const [res] = await knex.raw(
      `DELETE FROM member_notifications WHERE type = '${REMINDER_TYPE}' LIMIT 5000`,
    );
    deleted = res.affectedRows;
  } while (deleted === 5000);

  await setNotificationCheck(
    knex,
    NOTIFICATION_TYPES.filter((t) => t !== REMINDER_TYPE),
  );
};

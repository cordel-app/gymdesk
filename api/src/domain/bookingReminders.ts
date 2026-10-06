/**
 * #1113 §2–§6: the pre-event training reminder.
 *
 * This module is the one place that decides **what a reminder is** — the alert
 * type, how far ahead of the event it is raised, which bookings are owed one,
 * and what each row's payload says. It is pure: no `db`, no `express`, no
 * `t()`, so every rule below is assertable without a database or a scheduled
 * run. `api/src/api/booking-reminders.ts` is the I/O half and decides nothing,
 * the same split #1083/#1085/#1086 use for the same reason.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * **Nothing is stored to remember that a reminder was sent.** The dedupe is the
 * `member_notifications` row itself (`NOT EXISTS` on this type for that member
 * and that occurrence), which is #647 stage 4's device and the reason
 * `recordNotifications()` awaits its insert. A `reminder_sent_at` column on
 * `calendar_event_bookings` would be a second record of the same fact, and a
 * run that wrote the column but lost the row — or the reverse — would either
 * silence a member for good or alert them on every pass (§5). It also answers
 * §6 by construction: the reminder is keyed on the *booking's own occurrence*,
 * so cancelling Event A and booking Event B owes a reminder for B and never for
 * A, and a cancelled booking simply stops being a candidate.
 *
 * **The lead time is a declared constant, not configuration.** The member reads
 * *"in 2 hours"* in their own language (`detail_booking_reminder_2h`), so a
 * deployment that could move the lead to 45 minutes would make that sentence
 * false — the copy and the number have to change together, which is what a
 * constant beside the type name expresses. CLAUDE.md's "all config via
 * environment variables" is about deployment facts (hosts, credentials,
 * limits); a figure the product says out loud is not one.
 *
 * **The window is "within the lead time", not "exactly at it".** A scheduled
 * runner fires late — GitHub's cron is best-effort — so asking for events
 * starting in 115–120 minutes would silently drop every member whose event fell
 * between two passes. Asking for every booked event that starts *within* the
 * next two hours and has no reminder yet makes a late pass cost punctuality
 * rather than the alert, and the dedupe keeps it at most once (§5).
 */

import type { NotificationRow } from '../infra/notifications';

/**
 * The alert type. Deliberately a third reminder value rather than a reuse of
 * `booking_reminder_24h` / `booking_reminder_1h`, which migration 087 declared
 * and nothing has ever written: those two are a different promise (*"tomorrow"*,
 * *"starting soon"*) with their own copy already in all three locales, and
 * writing this reminder under one of them would make the Alerts page say
 * something other than what §2 asks for. They stay unwritten — retired by
 * disuse, not deleted — exactly as the CHECK is allowed to be a superset of the
 * union (migration 217's own note).
 */
export const BOOKING_REMINDER_TYPE = 'booking_reminder_2h' as const;

/** How far ahead of `starts_at` the reminder is raised (§2). */
export const BOOKING_REMINDER_LEAD_MINUTES = 120;

/**
 * The most reminders one pass may raise, across every gym.
 *
 * A bound rather than a page: the next pass picks up whatever is left, because
 * a candidate stays a candidate until its row exists. It is here so a gym that
 * opens a hundred classes at the same hour cannot turn one pass into an
 * unbounded insert, and so the run's own counters stay readable.
 *
 * It is **interpolated into the SQL rather than bound as a parameter**, which is
 * this codebase's one way of spelling a `LIMIT` (`recurring-bookings.ts`'s own
 * safety valve does the same with a value that comes from a request body, after
 * validating it as an integer). `db.query` is mysql2's `execute()`, i.e. a
 * server-side prepared statement, and a bound `LIMIT ?` is refused there — which
 * is what made every pass of this run answer `500` the first time it reached CI.
 * Interpolation is safe because this is a module constant and never a request
 * value, and `limitClause()` asserts that rather than trusting it.
 */
export const BOOKING_REMINDER_MAX_PER_RUN = 500;

/** One row of the candidate query. */
export interface ReminderCandidate {
  gym_id: string;
  member_id: number;
  calendar_event_id: number;
  title: string;
  starts_at: string | Date;
}

/**
 * Every booking owed a reminder right now, across every gym.
 *
 * The conditions are §3's, and each one is load-bearing:
 *
 * - `ceb.status = 'booked'` — an *active* booking. A `waitlisted` row is not one
 *   (the member holds a place in a queue, not a training), and `cancelled` is
 *   what §3's "must not generate the reminder if the member has cancelled"
 *   means. There is no fourth status (`chk_ceb_status`, migration 132).
 * - `ce.status = 'scheduled'` — "the event is still scheduled". A `cancelled`
 *   occurrence has its own alert (#979 `event_cancelled`) and a `completed` or
 *   `draft` one is not a training about to start.
 * - `ce.deleted_at IS NULL` and the member not soft-deleted, because both are
 *   gone from every other screen.
 * - the window, compared **in SQL** against `UTC_TIMESTAMP()`: `starts_at` is a
 *   UTC `DATETIME` by this codebase's convention, so no value crosses a
 *   timezone conversion on the way to a comparison (`> UTC_TIMESTAMP()` is the
 *   form every other "upcoming occurrence" read uses).
 * - the `NOT EXISTS`, which is the whole of §5.
 *
 * The title is the **occurrence's own** `calendar_events.title` (#981's rule),
 * which is the Activity Type's name for a scheduled session (`scheduleEngine`
 * writes it) and the entry's own name for a manual one — so this needs no join
 * to `activity_types` and cannot answer `null` for an occurrence that has none.
 */
export function reminderCandidatesSql(limit: number = BOOKING_REMINDER_MAX_PER_RUN): string {
  return `
    SELECT ce.gym_id, ceb.member_id, ce.id AS calendar_event_id, ce.title, ce.starts_at
      FROM calendar_event_bookings ceb
      JOIN calendar_events ce ON ce.id = ceb.calendar_event_id
      JOIN members m ON m.id = ceb.member_id AND m.gym_id = ceb.gym_id
     WHERE ceb.status = 'booked'
       AND ce.status = 'scheduled'
       AND ce.deleted_at IS NULL
       AND m.deleted_at IS NULL
       AND ce.starts_at > UTC_TIMESTAMP()
       AND ce.starts_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
       AND NOT EXISTS (
             SELECT 1 FROM member_notifications mn
              WHERE mn.gym_id = ce.gym_id
                AND mn.member_id = ceb.member_id
                AND mn.type = '${BOOKING_REMINDER_TYPE}'
                AND mn.entity_type = 'session'
                AND mn.entity_id = ce.id)
     ORDER BY ce.starts_at, ce.gym_id, ceb.member_id
     ${limitClause(limit)}`;
}

/**
 * `LIMIT <n>`, with the integer written into the statement.
 *
 * The assertion is the whole safety argument: the only caller passes a module
 * constant, so a non-integer here means a value reached this function that
 * never should have, and failing loudly is better than interpolating it.
 */
function limitClause(limit: number): string {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`booking reminder limit must be a positive integer, got ${limit}`);
  }
  return `LIMIT ${limit}`;
}

/** The parameters `reminderCandidatesSql()` takes, in order. */
export function reminderCandidatesParams(
  leadMinutes: number = BOOKING_REMINDER_LEAD_MINUTES,
): [number] {
  return [leadMinutes];
}

/**
 * The notification row one candidate becomes.
 *
 * The payload carries the occurrence's name and its start time and **no
 * sentence**: what the member reads is the Members App's own locale keys
 * (`type_booking_reminder_2h` + `detail_booking_reminder_2h`), which is where
 * every other alert's copy lives and the only place that can pick a language —
 * the same reason a push carries no sentence either (#1072).
 */
export function reminderNotificationRow(candidate: ReminderCandidate): NotificationRow {
  return {
    memberId: Number(candidate.member_id),
    type: BOOKING_REMINDER_TYPE,
    entityType: 'session',
    entityId: Number(candidate.calendar_event_id),
    payload: {
      title: candidate.title,
      starts_at: candidate.starts_at instanceof Date
        ? candidate.starts_at.toISOString()
        : candidate.starts_at,
    },
  };
}

/**
 * The candidates grouped by gym, because `recordNotifications()` writes one
 * gym's rows at a time (its `gym_id` is a column of every row it inserts).
 * Insertion order is the query's, so the soonest event is written first.
 */
export function groupRemindersByGym(
  candidates: ReminderCandidate[],
): Map<string, NotificationRow[]> {
  const byGym = new Map<string, NotificationRow[]>();
  for (const candidate of candidates) {
    const rows = byGym.get(candidate.gym_id) ?? [];
    rows.push(reminderNotificationRow(candidate));
    byGym.set(candidate.gym_id, rows);
  }
  return byGym;
}

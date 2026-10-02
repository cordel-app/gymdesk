/**
 * #977 — a calendar event's **execution status**: what happened to the event
 * itself, as distinct from what happened with its members.
 *
 * Four values, and the ticket is explicit that they are one axis (§10 — "do
 * not merge these into a single status field"):
 *
 *   • `scheduled` — the event has not finished, or it finished with bookings
 *     and nobody has confirmed it yet (§13);
 *   • `not_used`  — it finished with no bookings at all. Automatic: a gym
 *     whose calendar is mostly open slots for private classes must not be
 *     handed one confirmation task per empty hour (§3);
 *   • `completed` — a human said the session took place (§4), which is the
 *     only way this value is ever reached, so `Completed · 0 attendees`
 *     stays expressible (§5);
 *   • `cancelled` — a human cancelled it (§6).
 *
 * It is **derived on every read and never stored**: `not_used` is a function
 * of the clock and the booking count, so storing it would need a nightly
 * sweep to write a column nothing else decides — and a sweep that skipped a
 * night would report yesterday's empty slots as still `Scheduled`. The two
 * values a *person* chooses are the ones `calendar_events.status` already
 * carries, and this module only ever reads them.
 *
 * `null` means "this event has no execution status": a `draft` manual event
 * (migration 134's event-only status) was never put on the calendar, so it
 * neither ran nor went unused, and the caller keeps showing `draft`. Nothing
 * here invents a fifth value.
 *
 * Deliberately not `computeCalendarEventStatus()` (`api/src/api/me.ts`, #503
 * stage 5), which answers the *member*-facing lifecycle: that one has
 * `running` and must never answer `not_used`, because an unused slot is an
 * Admin operational concept and members may not be shown that one existed
 * (§15, and #976 §2/§6/§7 for the member-side half of the same rule). Two
 * vocabularies for two audiences, each decided in one place.
 */

export const EVENT_EXECUTION_STATUSES = ['scheduled', 'not_used', 'completed', 'cancelled'] as const;

export type EventExecutionStatus = (typeof EVENT_EXECUTION_STATUSES)[number];

export interface EventExecutionInput {
  /** `calendar_events.status` as stored: draft | scheduled | completed | cancelled. */
  status: string | null | undefined;
  /** `calendar_events.ends_at` — a `Date` from mysql2 (pool timezone 'Z') or an ISO string. */
  ends_at: Date | string | null | undefined;
  /**
   * Bookings that count as participation, i.e. the `booked_count` both read
   * paths already project (`calendar_event_bookings.status = 'booked'`).
   * A waitlisted member did not take part, and a cancelled booking is gone —
   * so neither keeps a slot out of `not_used`.
   */
  booked_count: number | string | null | undefined;
}

/**
 * The execution status of one event, or `null` when it has none (see above).
 *
 * An explicit decision outranks the clock in both directions: a `cancelled`
 * event that happens to have run out of bookings is `cancelled`, not
 * `not_used`, and a `completed` one stays `completed` however empty it was.
 * Only a `scheduled` row is ever reclassified, and only once it has ended.
 *
 * The comparison is made in Node against `now`, following
 * `computeCalendarEventStatus()`'s precedent: the pool runs at timezone 'Z',
 * so a DATETIME comes back as a real instant and `ends_at <= now` is the same
 * question SQL's `UTC_TIMESTAMP()` would answer.
 */
export function eventExecutionStatus(
  event: EventExecutionInput,
  now: Date = new Date(),
): EventExecutionStatus | null {
  if (event.status === 'cancelled') return 'cancelled';
  if (event.status === 'completed') return 'completed';
  if (event.status !== 'scheduled') return null;

  const ends = event.ends_at == null ? null : new Date(event.ends_at);
  const ended = ends != null && !Number.isNaN(ends.getTime()) && ends.getTime() <= now.getTime();
  if (!ended) return 'scheduled';

  // A row whose booking count was not projected is not evidence of an empty
  // slot: answer `scheduled` rather than reporting a session as never used.
  // `Number(null)` is 0, so the absent cases are rejected before the cast —
  // otherwise a read that forgot the aggregate would file every past event
  // away as never having run.
  if (event.booked_count == null || event.booked_count === '') return 'scheduled';
  const booked = Number(event.booked_count);
  if (!Number.isFinite(booked)) return 'scheduled';

  return booked > 0 ? 'scheduled' : 'not_used';
}

/**
 * Adds `execution_status` to a read's rows.
 *
 * Every admin-facing read of `calendar_events` goes through this, so the
 * calendar, the session panel and a future report cannot each decide what
 * `Not used` means — the rule above is reported by the API and re-derived by
 * no caller.
 */
export function withEventExecutionStatus<T extends EventExecutionInput>(
  rows: T[],
  now: Date = new Date(),
): (T & { execution_status: EventExecutionStatus | null })[] {
  return rows.map((row) => ({ ...row, execution_status: eventExecutionStatus(row, now) }));
}

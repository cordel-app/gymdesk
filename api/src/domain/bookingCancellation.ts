// #1162 — whether a member may cancel their own booking, decided in one place.
//
// The rule, as the ticket states it (§2/§3): a booking can be cancelled while
// the event is at least `CANCELLATION_NOTICE_HOURS` away, **or** while the
// booking itself is less than `CANCELLATION_GRACE_HOURS` old — the grace
// period that lets a member undo a same-day booking they made moments ago.
// Inside the notice window with the grace period spent, it cannot.
//
// Three things are the rule rather than the implementation:
//
//  * **A place on a waiting list is not a booking** (#980's distinction), so
//    leaving one is never inside the window: a waitlisted member holds nothing
//    the gym has to plan around, and a `waitlisted` row has no `booked_at`
//    at all. The one limit it shares with a booking is the event starting.
//  * **The timestamps are compared, never the calendar dates** (§3): the two
//    inputs are *seconds*, computed in SQL from `calendar_events.starts_at`
//    and `calendar_event_bookings.booked_at` against `UTC_TIMESTAMP()`, so
//    no DATETIME crosses a timezone conversion on the way here and the same
//    numbers answer the reads' `can_cancel` and the DELETE's refusal.
//  * **The two durations are declared constants, not configuration**: the
//    member reads *24 hours* in their own language in the refusal, so the
//    copy and the number change together (the reasoning #1113 records for
//    the reminder lead time).
//
// `booked_at` is the one booking-creation timestamp (§1/§8): written by the
// INSERT of a `booked` row and by a waitlist promotion (the moment the member
// *gained* a booking), never updated otherwise, and it is what both apps show
// as *Booked on*. A row with no `booked_at` — a legacy booking — gets no grace
// period rather than an invented one.

export const CANCELLATION_NOTICE_HOURS = 24;
export const CANCELLATION_GRACE_HOURS = 2;

export type CancellationBlock = 'already_started' | 'window_closed';

export interface MemberCancellationInput {
  /** The booking row's own status; anything but `booked` is a waiting-list place or already cancelled. */
  status: string | null;
  /** `TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), ce.starts_at)` — negative once the event has started. */
  secondsUntilStart: number;
  /** `TIMESTAMPDIFF(SECOND, ceb.booked_at, UTC_TIMESTAMP())`, or `null` when the row carries no `booked_at`. */
  secondsSinceBooked: number | null;
}

export interface MemberCancellationDecision {
  allowed: boolean;
  block: CancellationBlock | null;
}

export function decideMemberCancellation(input: MemberCancellationInput): MemberCancellationDecision {
  if (!(input.secondsUntilStart > 0)) return { allowed: false, block: 'already_started' };
  if (input.status !== 'booked') return { allowed: true, block: null };
  if (input.secondsUntilStart >= CANCELLATION_NOTICE_HOURS * 3600) return { allowed: true, block: null };
  if (input.secondsSinceBooked !== null && input.secondsSinceBooked < CANCELLATION_GRACE_HOURS * 3600) {
    return { allowed: true, block: null };
  }
  return { allowed: false, block: 'window_closed' };
}

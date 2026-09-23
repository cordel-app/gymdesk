import { DateTime } from 'luxon';

/**
 * #647 stage 2: the weekly availability projection behind
 * `GET /members/:memberId/personal-training-slots`.
 *
 * The ticket asks for a Mon–Sun grid of *recurring* Personal Training slots a
 * Member could take — "Monday 10:00–11:00" rather than a list of dates — over
 * a rolling 2-month window. Everything in this file is pure: the SQL that
 * feeds it lives in `api/src/api/member-personal-training-slots.ts`, so the
 * projection rules are unit-testable without a database.
 *
 * **What makes a slot a slot.** Occurrences are `calendar_events` rows, each
 * stored in UTC (`scheduleEngine.materializeScheduleRule()` converts the
 * gym-local rule time through the gym's `timezone`). A slot is therefore the
 * group of occurrences sharing the same *gym-local* weekday, start time and
 * end time, for the same Activity Type and Professional Service — the same
 * four things a Member would recognise as "my Monday PT session". Grouping on
 * the local time, not the UTC one, is what keeps a slot whole across a DST
 * change: 10:00 local is 09:00Z in winter and 08:00Z in summer.
 *
 * **Why a slot is not dropped when one date is taken.** §1 of the ticket asks
 * for slots available on *every* occurrence in the window, but the thread's
 * answer to Q5 overrides it:
 *
 *   > If a slot is already booked or it is a festivity, system will silently
 *   > ignore it. […] user will identify at day one the slots Monday 10:00 -
 *   > 11:00 and Wednesday 12:00 - 13:00 and then system will book the
 *   > calendar_event every night
 *
 * So a single full Monday must not erase "Monday 10:00–11:00" from the grid —
 * the window is rolling and the stage-4 job simply skips what it cannot take.
 * Every slot is therefore reported with its whole date-by-date picture:
 * `dates` carries one entry per expected occurrence with a reason when it is
 * not bookable, and `fully_available` still answers §1's stricter question for
 * a caller that wants it.
 *
 * **Expected dates.** A weekday that has no `calendar_events` row at that time
 * on some date in the window is the common case, not an error: the gym closed
 * (`gym_holiday_hours`), the schedule rule ends before the window does, or the
 * occurrence was cancelled. Those dates are listed with `no_occurrence` rather
 * than silently omitted, so the UI can say "7 of 9 dates" instead of implying
 * the slot runs every week.
 *
 * This module decides nothing about credits. How many sessions the Member
 * holds per service comes from `memberProfessionalServices.ts` (stage 1) and
 * is reported alongside the grid; whether booking one *spends* a credit is the
 * booking path's business, and stage 3 goes through it rather than around it.
 */

/** Why a given date of a recurring slot cannot be booked right now. */
export type SlotDateStatus =
  /** Bookable: a scheduled occurrence with a free seat that the Member does not hold yet. */
  | 'available'
  /** No `calendar_events` row for this weekday/time on this date (closure, rule ended, occurrence deleted). */
  | 'no_occurrence'
  /** The occurrence exists but is cancelled or already completed — `bookMemberOnSession` rejects both. */
  | 'not_scheduled'
  /** Every seat is taken (`booked_count >= effective_capacity`). */
  | 'full'
  /** The Member already holds a booking or a waitlist place on this occurrence. */
  | 'already_booked';

/** One occurrence row as the loader returns it. Times are UTC, as stored. */
export interface SlotOccurrenceRow {
  calendar_event_id: number;
  starts_at: Date | string;
  ends_at: Date | string;
  status: string;
  activity_type_id: number;
  activity_type_name: string;
  professional_service_id: number;
  professional_service_name: string;
  /** `calendar_events.center_id` — null in a single-center gym. */
  center_id: number | null;
  center_name: string | null;
  /** `COALESCE(ce.capacity, at.max_capacity)`. */
  effective_capacity: number | string | null;
  booked_count: number | string;
  /** 1 when this Member already has a 'booked' or 'waitlisted' row on the occurrence. */
  member_booked: number | boolean;
}

export interface SlotDate {
  /** Gym-local date, YYYY-MM-DD. */
  date: string;
  calendar_event_id: number | null;
  status: SlotDateStatus;
}

/**
 * The six columns that identify one recurring slot — the projection's grouping
 * key, and (stage 3, migration 169) the identity of a stored selection.
 */
export interface SlotIdentity {
  /** ISO weekday, 1=Monday … 7=Sunday. */
  weekday: number;
  /** Gym-local HH:MM. */
  start_time: string;
  end_time: string;
  activity_type_id: number;
  professional_service_id: number;
  center_id: number | null;
}

export interface WeeklySlot extends SlotIdentity {
  professional_service_name: string;
  activity_type_name: string;
  center_name: string | null;
  /** Dates in the window on which this weekday/time is expected, in order. */
  dates: SlotDate[];
  /** `dates.length` — how many times the slot comes round in the window. */
  occurrence_count: number;
  /** Dates the Member could book right now. */
  available_count: number;
  /** Dates the Member already holds. */
  already_booked_count: number;
  /** §1's stricter reading: every expected date is bookable. */
  fully_available: boolean;
  /** Stage 3: the Member has this weekly pattern stored in `member_recurring_slots`. */
  selected: boolean;
}

export interface WeeklySlotDay {
  weekday: number;
  slots: WeeklySlot[];
}

export interface WeeklySlotProjectionInput {
  /** IANA zone of the gym — occurrences are grouped and labelled in it. */
  timezone: string;
  /** Start of the window (inclusive). Usually "now". */
  from: DateTime;
  /** End of the window (exclusive). Usually now + 2 months. */
  to: DateTime;
  occurrences: SlotOccurrenceRow[];
  /**
   * Activity Types the Member is allowed to book (#481 eligibility). Anything
   * else is dropped before grouping: showing a slot the booking path would
   * reject with 403 is worse than not showing it.
   */
  eligibleActivityTypeIds: Set<number>;
  /**
   * Stage 3: `slotIdentityKey()` of every stored selection, so each projected
   * slot can report whether it is one the Member picked. Omitted by callers
   * that only want availability.
   */
  selectedKeys?: Set<string>;
}

function toLocal(value: Date | string, timezone: string): DateTime {
  const dt = value instanceof Date
    ? DateTime.fromJSDate(value, { zone: 'utc' })
    // mysql2 is configured with timezone:'Z', so a string value is UTC too.
    : DateTime.fromSQL(String(value).replace('T', ' ').replace('Z', ''), { zone: 'utc' });
  return dt.setZone(timezone);
}

/**
 * Key identifying one recurring slot: same local weekday + time, same activity,
 * same service, same center.
 *
 * The center belongs in the key even though nothing filters on it: in a
 * multi-center gym the same activity runs at the same local time in two places,
 * and those are two slots a Member picks between — collapsing them would drop
 * one center's occurrences on the floor (only the first row per date survives).
 */
export function slotIdentityKey(s: SlotIdentity): string {
  return `${s.weekday}|${s.start_time}|${s.end_time}|${s.activity_type_id}|${s.professional_service_id}|${s.center_id ?? ''}`;
}

/**
 * Every gym-local date in [from, to) whose local `weekday` matches and whose
 * slot start time has not already passed.
 *
 * The first date is included only when the slot still lies ahead of `from`:
 * a Monday 10:00 slot is not "expected" on a Monday at 11:00, and counting it
 * as a missed occurrence would make every slot look partially unavailable for
 * the rest of the day it falls on.
 */
export function expectedSlotDates(
  weekday: number,
  startTime: string,
  from: DateTime,
  to: DateTime,
): string[] {
  const [hour, minute] = startTime.split(':').map(Number);
  const dates: string[] = [];
  let cursor = from.startOf('day');
  // Advance to the first matching weekday on or after `from`'s date.
  cursor = cursor.plus({ days: (weekday - cursor.weekday + 7) % 7 });
  while (cursor < to) {
    const slotStart = cursor.set({ hour, minute, second: 0, millisecond: 0 });
    if (slotStart >= from && slotStart < to) dates.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ weeks: 1 });
  }
  return dates;
}

function dateStatus(row: SlotOccurrenceRow): SlotDateStatus {
  if (Number(row.member_booked) === 1 || row.member_booked === true) return 'already_booked';
  if (row.status !== 'scheduled') return 'not_scheduled';
  // A missing capacity means "not limited here" rather than "no seats": both
  // ce.capacity and at.max_capacity being null is a data state the booking
  // path treats as unbounded (NaN >= NaN is false in bookMemberOnSession's
  // comparison too), so the projection must not read it as full. Note that
  // Number(null) is 0, which would read as "every seat taken" — hence the
  // explicit null check before the conversion.
  if (row.effective_capacity != null) {
    const capacity = Number(row.effective_capacity);
    if (Number.isFinite(capacity) && Number(row.booked_count) >= capacity) return 'full';
  }
  return 'available';
}

/**
 * Fold occurrence rows into the Mon–Sun grid.
 *
 * Days with no slots are still returned (as empty arrays) so the caller renders
 * seven columns without inventing the missing ones.
 */
export function projectWeeklySlots(input: WeeklySlotProjectionInput): WeeklySlotDay[] {
  const { timezone, from, to, occurrences, eligibleActivityTypeIds, selectedKeys } = input;

  // One pass to bucket occurrences by slot and by local date. A slot can hold
  // at most one occurrence per date; when a gym has somehow scheduled two
  // identical events, the first wins and the duplicate is ignored rather than
  // counted twice.
  const groups = new Map<string, {
    slot: Omit<WeeklySlot, 'dates' | 'occurrence_count' | 'available_count' | 'already_booked_count' | 'fully_available' | 'selected'>;
    byDate: Map<string, SlotOccurrenceRow>;
  }>();

  for (const row of occurrences) {
    if (!eligibleActivityTypeIds.has(row.activity_type_id)) continue;
    const localStart = toLocal(row.starts_at, timezone);
    const localEnd = toLocal(row.ends_at, timezone);
    if (!localStart.isValid || !localEnd.isValid) continue;
    if (localStart < from || localStart >= to) continue;

    const identity = {
      weekday: localStart.weekday, // luxon: 1=Mon … 7=Sun
      start_time: localStart.toFormat('HH:mm'),
      end_time: localEnd.toFormat('HH:mm'),
      activity_type_id: row.activity_type_id,
      professional_service_id: row.professional_service_id,
      center_id: row.center_id ?? null,
    };
    const key = slotIdentityKey(identity);
    let group = groups.get(key);
    if (!group) {
      group = {
        slot: {
          ...identity,
          professional_service_name: row.professional_service_name,
          activity_type_name: row.activity_type_name,
          center_name: row.center_name ?? null,
        },
        byDate: new Map(),
      };
      groups.set(key, group);
    }
    const date = localStart.toFormat('yyyy-MM-dd');
    if (!group.byDate.has(date)) group.byDate.set(date, row);
  }

  const byWeekday = new Map<number, WeeklySlot[]>();
  for (let wd = 1; wd <= 7; wd++) byWeekday.set(wd, []);

  for (const { slot, byDate } of groups.values()) {
    const dates: SlotDate[] = expectedSlotDates(slot.weekday, slot.start_time, from, to).map((date) => {
      const row = byDate.get(date);
      return row
        ? { date, calendar_event_id: row.calendar_event_id, status: dateStatus(row) }
        : { date, calendar_event_id: null, status: 'no_occurrence' as const };
    });

    const availableCount = dates.filter((d) => d.status === 'available').length;
    const alreadyBookedCount = dates.filter((d) => d.status === 'already_booked').length;

    byWeekday.get(slot.weekday)!.push({
      ...slot,
      dates,
      occurrence_count: dates.length,
      available_count: availableCount,
      already_booked_count: alreadyBookedCount,
      fully_available: dates.length > 0 && availableCount === dates.length,
      selected: selectedKeys?.has(slotIdentityKey(slot)) ?? false,
    });
  }

  return [...byWeekday.entries()].map(([weekday, slots]): WeeklySlotDay => ({
    weekday,
    slots: slots.sort(
      (a, b) =>
        a.start_time.localeCompare(b.start_time) ||
        a.end_time.localeCompare(b.end_time) ||
        a.professional_service_name.localeCompare(b.professional_service_name) ||
        a.activity_type_name.localeCompare(b.activity_type_name) ||
        (a.center_name ?? '').localeCompare(b.center_name ?? ''),
    ),
  }));
}

/* ── Stage 3: turning stored selections into work ──────────────────────────── */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parse the `slots` array of a selection request into slot identities.
 *
 * Returns `{ error }` rather than throwing so the router can answer 400 with
 * the offending entry's index. Times are normalised to `HH:MM` — the form the
 * projection groups on — and `center_id` is optional, since a single-center
 * gym's occurrences carry none.
 *
 * Whether the identity actually exists in the Member's grid is *not* decided
 * here: that needs the projection, and the router checks it against the very
 * same `slotIdentityKey()` this file builds.
 */
export function parseSlotIdentities(
  raw: unknown,
): { slots: SlotIdentity[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'slots must be an array' };

  const slots: SlotIdentity[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const at = `slots[${index}]`;
    if (typeof entry !== 'object' || entry === null) return { error: `${at} must be an object` };
    const e = entry as Record<string, unknown>;

    const weekday = Number(e.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return { error: `${at}.weekday must be an integer 1..7 (1=Monday)` };
    }

    const times: Record<string, string> = {};
    for (const field of ['start_time', 'end_time'] as const) {
      const value = typeof e[field] === 'string' ? (e[field] as string).slice(0, 5) : '';
      if (!TIME_RE.test(value)) return { error: `${at}.${field} must be HH:MM` };
      times[field] = value;
    }
    if (times.end_time <= times.start_time) {
      return { error: `${at}.end_time must be later than start_time` };
    }

    const ids: Record<string, number> = {};
    for (const field of ['activity_type_id', 'professional_service_id'] as const) {
      const value = Number(e[field]);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: `${at}.${field} must be a positive integer` };
      }
      ids[field] = value;
    }

    let centerId: number | null = null;
    if (e.center_id != null) {
      const value = Number(e.center_id);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: `${at}.center_id must be a positive integer or null` };
      }
      centerId = value;
    }

    const identity: SlotIdentity = {
      weekday,
      start_time: times.start_time,
      end_time: times.end_time,
      activity_type_id: ids.activity_type_id,
      professional_service_id: ids.professional_service_id,
      center_id: centerId,
    };
    // A repeated identity is dropped rather than rejected: the stored set is a
    // set, and `mrs_selection_unique` would fail the whole PUT on the second
    // INSERT of the pair.
    const key = slotIdentityKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push(identity);
  }

  return { slots };
}

/** How one occurrence of a selected slot ended up. */
export interface BookingResult {
  date: string;
  calendar_event_id: number | null;
  outcome: 'booked' | 'skipped' | 'failed';
  /** Why it was skipped (a projection status) or why it failed (an error code). */
  reason?: string;
  booking_id?: number;
}

/** A date of a selected slot that will not be booked, and why not. */
export interface SkippedSlotDate {
  date: string;
  calendar_event_id: number | null;
  /** The projection status that ruled it out — never 'available'. */
  reason: Exclude<SlotDateStatus, 'available'>;
}

/** What the Book action (and stage 4's nightly job) should do for one selection. */
export interface SlotBookingPlan {
  selection: SlotIdentity;
  /**
   * The projected slot this selection resolves to, or `null` when it no longer
   * appears in the grid — the Member lost the Professional Service, the plan
   * stopped being eligible for the Activity Type (#481), or the schedule rule
   * that produced the occurrences was retired. §5: no new bookings then, and
   * the bookings already made are left exactly as they are.
   */
  slot: WeeklySlot | null;
  /** Occurrences to put through the booking path, in date order. */
  book: { date: string; calendar_event_id: number }[];
  /** Occurrences deliberately passed over, with the projection's reason. */
  skip: SkippedSlotDate[];
}

/**
 * Resolve stored weekly selections against a projection.
 *
 * Pure on purpose: the same fold serves the Book button (stage 3) and the
 * nightly rolling-window job (stage 4), and the "which dates does this weekly
 * pattern mean *this* week?" question is the one most worth testing without a
 * database.
 *
 * Only `available` dates are handed to the booking path. `already_booked` is
 * how §3's "do not create duplicate bookings" is honoured before the unique
 * index has to; `full`, `not_scheduled` and `no_occurrence` are the thread's
 * Q5 answer ("system will silently ignore it") — reported, never fatal. The
 * booking path revalidates each one anyway, so a date that goes stale between
 * this plan and the INSERT is caught there too.
 */
export function planSlotBookings(
  days: WeeklySlotDay[],
  selections: SlotIdentity[],
): SlotBookingPlan[] {
  const byKey = new Map<string, WeeklySlot>();
  for (const day of days) {
    for (const slot of day.slots) byKey.set(slotIdentityKey(slot), slot);
  }

  return selections.map((selection) => {
    const slot = byKey.get(slotIdentityKey(selection)) ?? null;
    if (!slot) return { selection, slot: null, book: [], skip: [] };

    const book: { date: string; calendar_event_id: number }[] = [];
    const skip: SkippedSlotDate[] = [];
    for (const d of slot.dates) {
      if (d.status === 'available' && d.calendar_event_id != null) {
        book.push({ date: d.date, calendar_event_id: d.calendar_event_id });
      } else {
        skip.push({
          date: d.date,
          calendar_event_id: d.calendar_event_id,
          reason: d.status === 'available' ? 'no_occurrence' : d.status,
        });
      }
    }
    return { selection, slot, book, skip };
  });
}

/* ── Stage 4: telling the Member what the nightly job could not book ───────── */

/**
 * Skip reasons the Member is told about, and the shape the member app reads.
 *
 * The thread's Q5 answer asks for exactly this:
 *
 *   > What we could do is that the night scheduler when trying to book the new
 *   > calendar_events, can publish an alert into the membership app informing
 *   > that the booking on May 1st could not be completed because it is a
 *   > festivity or the gym is closed or it was already booked by another event.
 *
 * So the three reasons that map onto "your recurring slot will not happen on
 * this date" are alerted, and nothing else:
 *
 * - `no_occurrence` — no session was scheduled at all (a holiday, the gym
 *   closed, or the schedule rule stopped before the window did);
 * - `not_scheduled` — the session exists but was cancelled;
 * - `full` — every seat was taken by someone else first.
 *
 * `already_booked` is deliberately absent: the Member holding the place *is*
 * the desired outcome, and a nightly "you are already booked" notice is noise.
 * A `failed` outcome is absent too — an unexpected error is an operator's
 * problem (it is counted in the run report and logged), not something a Member
 * can act on, and alerting on it would turn a broken deploy into a per-member
 * inbox flood.
 */
export const NOTIFIED_SKIP_REASONS = ['no_occurrence', 'not_scheduled', 'full'] as const;

export type NotifiedSkipReason = (typeof NOTIFIED_SKIP_REASONS)[number];

function isNotifiedSkipReason(reason: string | undefined): reason is NotifiedSkipReason {
  return (NOTIFIED_SKIP_REASONS as readonly string[]).includes(reason ?? '');
}

/** One alert the nightly job will write to `member_notifications`. */
export interface SkipNotification {
  /** Gym-local date the slot was expected on, YYYY-MM-DD. */
  date: string;
  /** The occurrence that could not be taken — null when none was scheduled. */
  calendar_event_id: number | null;
  reason: NotifiedSkipReason;
  /** `slotIdentityKey()` of the selection, so a repeat can be recognised. */
  slot_key: string;
  weekday: number;
  start_time: string;
  end_time: string;
  professional_service_name: string | null;
  activity_type_name: string | null;
}

/** One selection's outcome, as the booking run reports it. */
export interface SlotRunReport {
  selection: SlotIdentity;
  slot: WeeklySlot | null;
  results: BookingResult[];
}

/**
 * Identity of an alert: one per (slot, date).
 *
 * Not per calendar event — a `no_occurrence` date has no event to key on, and
 * the whole point is to say "your Monday slot will not happen on the 1st".
 */
export function skipNotificationKey(slotKey: string, date: string): string {
  return `${slotKey}@${date}`;
}

/**
 * Which alerts the run should write, given the ones the Member already has.
 *
 * Dedupe is the reason this is a function and not a loop inside the job. The
 * window is *rolling*, so a date the job cannot book is re-examined on every
 * one of the ~60 nightly runs before it passes: without `alreadySent` a single
 * closed Monday would send the Member sixty identical notices. Keyed on
 * (slot, date) rather than (slot, date, reason) on purpose — a date that is
 * first `full` and later `not_scheduled` is still the same disappointment, and
 * re-alerting on the reason changing would reintroduce the flood for any
 * occurrence whose status wobbles.
 *
 * Only dates in the *future* part of the window are considered; a date already
 * past is nothing the Member can do anything about, and the projection stops
 * offering it anyway.
 */
export function planSkipNotifications(
  slots: SlotRunReport[],
  alreadySent: Set<string>,
): SkipNotification[] {
  const notifications: SkipNotification[] = [];
  const seen = new Set<string>(alreadySent);

  for (const report of slots) {
    const slotKey = slotIdentityKey(report.selection);
    for (const result of report.results) {
      if (result.outcome !== 'skipped') continue;
      if (!isNotifiedSkipReason(result.reason)) continue;

      const key = skipNotificationKey(slotKey, result.date);
      if (seen.has(key)) continue;
      seen.add(key);

      notifications.push({
        date: result.date,
        calendar_event_id: result.calendar_event_id,
        reason: result.reason,
        slot_key: slotKey,
        weekday: report.selection.weekday,
        start_time: report.selection.start_time,
        end_time: report.selection.end_time,
        professional_service_name: report.slot?.professional_service_name ?? null,
        activity_type_name: report.slot?.activity_type_name ?? null,
      });
    }
  }

  return notifications.sort((a, b) => a.date.localeCompare(b.date) || a.slot_key.localeCompare(b.slot_key));
}

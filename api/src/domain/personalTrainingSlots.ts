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

export interface WeeklySlot {
  /** ISO weekday, 1=Monday … 7=Sunday — the grid's column order. */
  weekday: number;
  /** Gym-local HH:MM. */
  start_time: string;
  end_time: string;
  professional_service_id: number;
  professional_service_name: string;
  activity_type_id: number;
  activity_type_name: string;
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
}

function toLocal(value: Date | string, timezone: string): DateTime {
  const dt = value instanceof Date
    ? DateTime.fromJSDate(value, { zone: 'utc' })
    // mysql2 is configured with timezone:'Z', so a string value is UTC too.
    : DateTime.fromSQL(String(value).replace('T', ' ').replace('Z', ''), { zone: 'utc' });
  return dt.setZone(timezone);
}

/** Key identifying one recurring slot: same local weekday + time, same activity, same service. */
function slotKey(s: {
  weekday: number; start_time: string; end_time: string;
  activity_type_id: number; professional_service_id: number;
}): string {
  return `${s.weekday}|${s.start_time}|${s.end_time}|${s.activity_type_id}|${s.professional_service_id}`;
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
  const { timezone, from, to, occurrences, eligibleActivityTypeIds } = input;

  // One pass to bucket occurrences by slot and by local date. A slot can hold
  // at most one occurrence per date; when a gym has somehow scheduled two
  // identical events, the first wins and the duplicate is ignored rather than
  // counted twice.
  const groups = new Map<string, {
    slot: Omit<WeeklySlot, 'dates' | 'occurrence_count' | 'available_count' | 'already_booked_count' | 'fully_available'>;
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
    };
    const key = slotKey(identity);
    let group = groups.get(key);
    if (!group) {
      group = {
        slot: {
          ...identity,
          professional_service_name: row.professional_service_name,
          activity_type_name: row.activity_type_name,
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
    });
  }

  return [...byWeekday.entries()].map(([weekday, slots]) => ({
    weekday,
    slots: slots.sort(
      (a, b) =>
        a.start_time.localeCompare(b.start_time) ||
        a.end_time.localeCompare(b.end_time) ||
        a.professional_service_name.localeCompare(b.professional_service_name) ||
        a.activity_type_name.localeCompare(b.activity_type_name),
    ),
  }));
}

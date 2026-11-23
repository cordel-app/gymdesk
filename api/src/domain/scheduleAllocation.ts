/**
 * #1325 PR 2a — which billing schedule a recurring item belongs to.
 *
 * One function, so the rule is applied the same way by every writer (Q8):
 *
 *   1. the item's cadence equals the Membership Plan's → the `plan` schedule;
 *   2. otherwise an existing schedule of the same cadence → that schedule;
 *   3. otherwise a new independent schedule anchored on the billing calendar's
 *      grid date on or before the purchase date (#2125 M5c,
 *      `calendarAnchorOnOrBefore()`), and the caller shows a warning.
 *
 * Joining an existing schedule means the item is charged a **prorated** amount
 * for the stretch from the purchase date to that schedule's next billing date
 * (`domain/proration.ts`). A new schedule is anchored on the calendar grid, so a
 * purchase between two grid dates is prorated to the next one by the engine
 * (`alignTo`); `prorate: false` only says no *existing* schedule was joined. Session allowances never reach this (#918). The
 * database's `UNIQUE (owner_member_id, schedule_key)` and the FK from
 * recurring items complement this function; they do not replace it.
 *
 * Pure: no database, no clock.
 */
import { calendarAnchorOnOrBefore, calendarGridOf, isOnCalendarGrid } from './calendarSchedule';

export type CadenceUnit = 'day' | 'week' | 'month' | 'year';
export interface Cadence { interval: number; unit: CadenceUnit }

export const PLAN_SCHEDULE_KEY = 'plan';

/**
 * The stored `(interval, unit)` of a billing frequency, or `null` when the
 * frequency names no recurring period (`once`, the retired `per_session`, an
 * absent value) — such an item has no schedule.
 */
export function cadenceForFrequency(frequency: string | null | undefined): Cadence | null {
  switch (frequency) {
    case 'week': return { interval: 1, unit: 'week' };
    case 'four_weeks': return { interval: 4, unit: 'week' };
    case 'month': return { interval: 1, unit: 'month' };
    case 'year': return { interval: 1, unit: 'year' };
    default: return null;
  }
}

export function sameCadence(a: Cadence, b: Cadence): boolean {
  return a.interval === b.interval && a.unit === b.unit;
}

export interface ExistingSchedule {
  id: number | null;
  key: string;
  anchorDate: string;
  cadence: Cadence;
}

export type ScheduleAllocation =
  | { kind: 'plan'; key: string; prorate: true }
  | { kind: 'existing'; key: string; prorate: true }
  | { kind: 'new'; key: string; anchorDate: string; prorate: false; warn: true };

/** `s1`, `s2`, … — the next free key, never reusing one a version already holds. */
export function nextScheduleKey(existingKeys: readonly string[]): string {
  let n = 0;
  for (const key of existingKeys) {
    const m = /^s(\d+)$/.exec(key);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `s${n + 1}`;
}

/**
 * #3165 stage 2 — whether `schedule` bills on the dates an item of `cadence`
 * bought on `purchaseDate` bills on by its **own** frequency calendar: for a
 * cadence with a grid (monthly on the 1st, the 4-week grid, Mondays) the
 * schedule's anchor must be a grid date; for one with no grid (yearly) the
 * schedule must fall on the purchase date's own anniversary (same month and
 * day). A schedule anchored elsewhere — a Membership Plan's schedule opened
 * before #2125 M5c on its start date (the 7th), or a yearly plan with another
 * anniversary — is not the item's calendar, so the item does not join it.
 */
export function billsOnOwnCalendar(schedule: ExistingSchedule, cadence: Cadence, purchaseDate: string): boolean {
  if (!sameCadence(schedule.cadence, cadence)) return false;
  if (calendarGridOf(cadence) != null) return isOnCalendarGrid(cadence, schedule.anchorDate);
  return schedule.anchorDate.slice(5, 10) === purchaseDate.slice(5, 10);
}

export function allocateSchedule(input: {
  cadence: Cadence;
  purchaseDate: string;
  schedules: readonly ExistingSchedule[];
  /**
   * #3165 stage 2 — an ad-hoc recurring Product follows its own frequency
   * calendar, never the Membership Plan's billing date: it joins an existing
   * schedule (the plan's included) only when that schedule bills on the
   * Product's own calendar (`billsOnOwnCalendar()`), else it opens its own.
   * A plan and a plan's included Products leave it unset (unchanged rule).
   */
  ownCalendar?: boolean;
}): ScheduleAllocation {
  const joinable = (s: ExistingSchedule) => sameCadence(s.cadence, input.cadence)
    && (!input.ownCalendar || billsOnOwnCalendar(s, input.cadence, input.purchaseDate));
  const plan = input.schedules.find((s) => s.key === PLAN_SCHEDULE_KEY);
  if (plan && joinable(plan)) {
    return { kind: 'plan', key: PLAN_SCHEDULE_KEY, prorate: true };
  }
  const match = input.schedules.find((s) => s.key !== PLAN_SCHEDULE_KEY && joinable(s));
  if (match) return { kind: 'existing', key: match.key, prorate: true };
  return {
    kind: 'new',
    key: nextScheduleKey(input.schedules.map((s) => s.key)),
    anchorDate: calendarAnchorOnOrBefore(input.cadence, input.purchaseDate),
    prorate: false,
    warn: true,
  };
}

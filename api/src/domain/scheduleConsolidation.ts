/**
 * #2125 M5c-2 (Oscar, 2026-11-11, Option B §7) — when two billing schedules of
 * one ProductSet chain are the same schedule, and what consolidating them does
 * to each Billing Event that hangs off the one that goes away.
 *
 * **Identity.** Two schedules are one when they bill on the same dates: the
 * same cadence and, for a cadence with a billing-calendar grid (monthly on the
 * 1st, 4-weekly on the 2026-11-02 grid, weekly on Mondays), nothing else —
 * every such schedule bills on that grid whatever date it was anchored on. A
 * cadence with no grid (yearly) keeps each obligation's own anniversary, so two
 * yearly schedules are one only when their anchors are the same date.
 *
 * **Target.** The `plan` schedule when the group holds it (it is the one the
 * cancellation entitlement, the checkout and the bridge look up by key), else
 * the oldest (lowest id).
 *
 * **Events of a merged schedule** (`classifyMergedEvent()`), against the
 * target's event for the same `period_start` (`UNIQUE (schedule_id,
 * period_start)`):
 *   - no such event, or no `period_start` → `repoint`: the event moves to the
 *     target unchanged (amount, lines, attempts and status untouched);
 *   - both are future (due after today), not-yet-attempted obligations →
 *     `regenerate`: both are deleted and the generator writes the date again
 *     on the target, with the lines of both (the obligation is not lost and not
 *     charged twice);
 *   - anything else (a past event, an attempt, a payment) → `keep`: the event
 *     stays on its own schedule, which is kept for it, and is reported. Payment
 *     history is never rewritten or merged.
 *
 * Pure: no database, no clock.
 */
import { calendarGridOf } from './calendarSchedule';
import { PLAN_SCHEDULE_KEY } from './scheduleAllocation';

export interface ConsolidatableSchedule {
  id: number;
  key: string;
  anchorDate: string;
  cadence: { interval: number; unit: string };
}

export interface ScheduleConsolidationGroup {
  targetId: number;
  mergedIds: number[];
}

export function sameScheduleIdentity(a: ConsolidatableSchedule, b: ConsolidatableSchedule): boolean {
  if (Number(a.cadence.interval) !== Number(b.cadence.interval) || a.cadence.unit !== b.cadence.unit) return false;
  if (calendarGridOf(a.cadence) != null) return true;
  return a.anchorDate.slice(0, 10) === b.anchorDate.slice(0, 10);
}

/** Groups of two or more schedules that are one schedule, each with the one they consolidate into. */
export function consolidationGroups(schedules: readonly ConsolidatableSchedule[]): ScheduleConsolidationGroup[] {
  const groups: ConsolidatableSchedule[][] = [];
  for (const s of [...schedules].sort((a, b) => a.id - b.id)) {
    const group = groups.find((g) => sameScheduleIdentity(g[0], s));
    if (group) group.push(s);
    else groups.push([s]);
  }
  return groups
    .filter((g) => g.length > 1)
    .map((g) => {
      const target = g.find((s) => s.key === PLAN_SCHEDULE_KEY) ?? g[0];
      return { targetId: target.id, mergedIds: g.filter((s) => s.id !== target.id).map((s) => s.id) };
    });
}

/**
 * The schedule of `schedules` a new schedule `(cadence, anchorDate)` would be,
 * or `null` when it is a new one.
 */
export function findScheduleWithIdentity(
  schedules: readonly ConsolidatableSchedule[], candidate: Omit<ConsolidatableSchedule, 'id' | 'key'>,
): ConsolidatableSchedule | null {
  return [...schedules].sort((a, b) => a.id - b.id)
    .find((s) => sameScheduleIdentity(s, { ...candidate, id: 0, key: '' })) ?? null;
}

export interface ConsolidationEvent {
  periodStart: string | null;
  billingDate: string | null;
  isScheduled: boolean;
  attempted: boolean;
}

export type MergedEventAction = 'repoint' | 'regenerate' | 'keep';

const untouchedFutureObligation = (e: ConsolidationEvent, today: string): boolean =>
  e.isScheduled && !e.attempted && e.billingDate != null && e.billingDate.slice(0, 10) > today;

export function classifyMergedEvent(
  event: ConsolidationEvent, targetEvent: ConsolidationEvent | null, today: string,
): MergedEventAction {
  if (event.periodStart == null || targetEvent == null) return 'repoint';
  if (untouchedFutureObligation(event, today) && untouchedFutureObligation(targetEvent, today)) return 'regenerate';
  return 'keep';
}

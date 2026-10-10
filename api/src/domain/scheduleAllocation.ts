/**
 * #1325 PR 2a — which billing schedule a recurring item belongs to.
 *
 * One function, so the rule is applied the same way by every writer (Q8):
 *
 *   1. the item's cadence equals the Membership Plan's → the `plan` schedule;
 *   2. otherwise an existing schedule of the same cadence → that schedule;
 *   3. otherwise a new independent schedule anchored on the purchase date, and
 *      the caller shows a warning.
 *
 * Joining an existing schedule means the item is charged a **prorated** amount
 * for the stretch from the purchase date to that schedule's next billing date
 * (`domain/proration.ts`); a new schedule starts on the purchase date, so there
 * is nothing to prorate. Session allowances never reach this (#918). The
 * database's `UNIQUE (root_product_set_id, schedule_key)` and the FK from
 * recurring items complement this function; they do not replace it.
 *
 * Pure: no database, no clock.
 */

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

export function allocateSchedule(input: {
  cadence: Cadence;
  purchaseDate: string;
  schedules: readonly ExistingSchedule[];
}): ScheduleAllocation {
  const plan = input.schedules.find((s) => s.key === PLAN_SCHEDULE_KEY);
  if (plan && sameCadence(plan.cadence, input.cadence)) {
    return { kind: 'plan', key: PLAN_SCHEDULE_KEY, prorate: true };
  }
  const match = input.schedules.find((s) => s.key !== PLAN_SCHEDULE_KEY && sameCadence(s.cadence, input.cadence));
  if (match) return { kind: 'existing', key: match.key, prorate: true };
  return {
    kind: 'new',
    key: nextScheduleKey(input.schedules.map((s) => s.key)),
    anchorDate: input.purchaseDate,
    prorate: false,
    warn: true,
  };
}

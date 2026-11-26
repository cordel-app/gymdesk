// #3445 stage 2 — which projected obligations the rolling window of future Scheduled Billing Events
// keeps. Pure: `planScheduledEvents()` (positiveOnly) asks it over the engine's per-schedule buckets.
//
// The window is the Product Set's, not each schedule's: the next `cycles` distinct billing DATES
// that owe something, chronologically across every schedule. Every positive obligation on a kept
// date is kept (whichever schedule owns it), so `materialiseScheduledEvents()` can consolidate them
// into one Billing Event; a date that comes later waits until the window advances. Three kinds of
// bucket never hold a slot, as before:
//   - a zero-value obligation (a free, prepaid or fully discounted cycle) is dropped;
//   - a one-off (no schedule) is always kept;
//   - a prorated first stretch (a line joining between two schedule dates, #2125 stage 9) is a stub,
//     not a cycle, and is always kept.

export interface WindowBucket {
  scheduleKey: string | null;
  date: string;
  amount: number;
  /** Every line of the bucket is a prorated stretch. */
  stub: boolean;
}

export interface WindowSelection {
  /** Indexes of the buckets kept, in input order. */
  kept: number[];
  /** The distinct dates holding a slot, ascending. */
  dates: string[];
  /** Fewer than `cycles` dates were found: a wider horizon may find more. */
  short: boolean;
}

export function selectGlobalWindow(buckets: readonly WindowBucket[], cycles: number): WindowSelection {
  const slotDates = [...new Set(buckets
    .filter((b) => b.scheduleKey !== null && !b.stub && b.amount > 0)
    .map((b) => b.date))].sort();
  const dates = slotDates.slice(0, Math.max(0, cycles));
  const inWindow = new Set(dates);
  const kept: number[] = [];
  buckets.forEach((b, i) => {
    if (b.scheduleKey === null || b.stub) { kept.push(i); return; }
    if (b.amount > 0 && inWindow.has(b.date)) kept.push(i);
  });
  return { kept, dates, short: dates.length < cycles };
}

/**
 * The schedule a consolidated event is filed under (`billing_events.schedule_id`): the plan's own
 * schedule when it has a line on the date, else the oldest schedule (lowest id). Deterministic, so
 * a concurrent writer of the same date collides on `UNIQUE (schedule_id, period_start)`.
 */
export function primaryScheduleIndex(groups: ReadonlyArray<{ scheduleKey: string | null; scheduleId: number | null }>,
  planKey: string): number {
  const plan = groups.findIndex((g) => g.scheduleKey === planKey && g.scheduleId != null);
  if (plan >= 0) return plan;
  let best = -1;
  groups.forEach((g, i) => {
    if (g.scheduleId == null) return;
    if (best < 0 || g.scheduleId < groups[best].scheduleId!) best = i;
  });
  return best >= 0 ? best : 0;
}

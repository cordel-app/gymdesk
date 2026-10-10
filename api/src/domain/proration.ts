/**
 * #1325 PR 2a — the prorated first charge of an item that joins a schedule.
 *
 * Decision D: *monthly price ÷ 31 × the days until the next billing date*,
 * every month taken as 31 days. This applies to the prorated charge (and to a
 * promotion's partial-month day count) **only** — `promotionTimeline.ts`'s
 * calendar-month Free/Paid/Bonus durations and the 4-week cadence are untouched.
 *
 * Amounts are VAT-inclusive euros, the unit the pricing engine already runs in,
 * so no tax arithmetic happens here; the result is rounded to the cent and the
 * line records the `prorated_days` and `period_days` it was computed from.
 *
 * The divisor for a cadence other than a plain month is not stated on the
 * ticket; this uses the cadence's own length in days (31 per month, 7 per week,
 * 372 for a year) so that a full period prorates to exactly its price. Pure.
 */

import { Cadence } from './scheduleAllocation';

const DAYS_PER_MONTH = 31;

/** The number of days one period of the cadence is taken to last. */
export function periodDays(cadence: Cadence): number {
  switch (cadence.unit) {
    case 'day': return cadence.interval;
    case 'week': return cadence.interval * 7;
    case 'month': return cadence.interval * DAYS_PER_MONTH;
    case 'year': return cadence.interval * 12 * DAYS_PER_MONTH;
  }
}

/** Whole days from `from` (inclusive) to `to` (exclusive); never negative. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export interface Proration {
  proratedDays: number;
  periodDays: number;
  amount: number;
}

/**
 * `price` is the item's price for one full period of `cadence`. The days are
 * capped at the period's own length, so a join one cycle early cannot charge
 * more than the period costs.
 */
export function prorate(price: number, cadence: Cadence, purchaseDate: string, nextBillingDate: string): Proration {
  const period = periodDays(cadence);
  const days = Math.min(daysBetween(purchaseDate, nextBillingDate), period);
  const amount = Math.round(((price / period) * days) * 100) / 100;
  return { proratedDays: days, periodDays: period, amount };
}

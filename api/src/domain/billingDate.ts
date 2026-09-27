/**
 * Billing date arithmetic — the one place a billing date is advanced.
 *
 * It lived in `api/src/api/billing.ts` until #635 stage 11, which made the
 * nightly run price each cycle through the same engine the Billing Simulation
 * uses. That engine (`domain/billingSimulation.ts`) already imported this
 * helper *from* the router, so the run importing the engine would have closed
 * an `api/billing → domain/billingSimulation → domain/planDuration →
 * api/billing` cycle. Moving the helper into its own leaf module removes the
 * `domain → api` edge for good; `api/billing.ts` re-exports it, so every
 * existing importer (and `advanceBillingDate`'s own unit test) is unchanged.
 */

/** `billing_policies.recurring_billing_unit` — the cadence vocabulary. */
export type BillingDateUnit = 'day' | 'week' | 'month' | 'year';

/**
 * `current` advanced by `interval` × `unit`, as a plain YYYY-MM-DD string.
 *
 * Month and year steps clamp the way `Date.setUTCMonth` does (31 Jan + 1 month
 * = 3 Mar). Every projection in the codebase inherits that behaviour by going
 * through this function rather than doing its own month arithmetic.
 */
export function advanceBillingDate(
  current: Date | string,
  interval: number,
  unit: BillingDateUnit,
): string {
  const d = new Date(current instanceof Date ? current.toISOString() : current);
  switch (unit) {
    case 'day':   d.setUTCDate(d.getUTCDate() + interval); break;
    case 'week':  d.setUTCDate(d.getUTCDate() + interval * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + interval); break;
    case 'year':  d.setUTCFullYear(d.getUTCFullYear() + interval); break;
  }
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Upper bound on the cycles `firstBillingDateAfter()` will walk. A daily
 * cadence back-dated a decade is ~3,650 steps; anything past this bound is a
 * corrupt row (a year-0001 `starts_at`), and looping on it would hang the
 * request that asked.
 */
const MAX_BILLING_DATE_STEPS = 10_000;

/**
 * The first cycle boundary strictly after `after` (#790): `anchor` advanced by
 * one cadence, then again and again, until the date is later than `after`.
 * Always at least one step, so an `anchor` that is today or in the future still
 * moves by exactly one cadence — which is what the first payment of an
 * assignment starting today or later has always stamped.
 *
 * Each step is `advanceBillingDate()`, the same step the nightly run takes, so
 * the date this returns is one the run would itself have reached from `anchor`:
 * the two can never disagree about month-end clamping (31 Jan steps to 3 Mar,
 * then 3 Apr). "Strictly after" is the point of the rule — a boundary equal to
 * `after` (today) would be charged by tonight's run, and that is the cycle the
 * caller has just settled or written off.
 *
 * Pass plain `YYYY-MM-DD` strings (`DATE_FORMAT` in SQL, `after` from
 * `UTC_DATE()`): they are compared as strings, so no DATE ever crosses a
 * timezone conversion.
 */
export function firstBillingDateAfter(
  anchor: string,
  interval: number,
  unit: BillingDateUnit,
  after: string,
): string {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error(`firstBillingDateAfter: interval must be a positive integer, got ${interval}`);
  }
  const bound = after.slice(0, 10);
  let date = advanceBillingDate(anchor.slice(0, 10), interval, unit);
  for (let steps = 1; date <= bound; steps++) {
    if (steps >= MAX_BILLING_DATE_STEPS) {
      throw new Error(`firstBillingDateAfter: more than ${MAX_BILLING_DATE_STEPS} cycles between ${anchor} and ${bound}`);
    }
    date = advanceBillingDate(date, interval, unit);
  }
  return date;
}

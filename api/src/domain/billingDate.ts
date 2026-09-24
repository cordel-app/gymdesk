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

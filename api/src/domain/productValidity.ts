// #1693 — when a purchased Product stops being valid, and what a cancellation
// does to that. Pure: dates are 'YYYY-MM-DD' strings in the gym's own calendar.
//
// Rules (the issue leaves them open; these reuse what the product already has):
//  1. An explicit `validity_days` on the Product wins: valid for that many days,
//     the purchase day included, so the last day is purchase + (days - 1).
//  2. Otherwise a recurring-period frequency gives the period the purchase paid
//     for: `month` → one calendar month (Oct 1 → Oct 31, Oct 15 → Nov 14),
//     `four_weeks` → 28 days, `year` → one year; the last day is the day before
//     the period would renew.
//  3. Otherwise (`once`, legacy `per_session`, ...) there is no defined validity:
//     `valid_until` is NULL and the product does not expire by itself.
// A cancellation never moves a defined end date. With none, the entitlement
// ends the day it is cancelled.

import { DateTime } from 'luxon';

export function computeValidUntil(input: {
  purchasedOn: string;
  validityDays: number | null;
  billingFrequency: string | null;
}): string | null {
  const start = DateTime.fromISO(input.purchasedOn, { zone: 'utc' });
  if (!start.isValid) return null;
  const days = input.validityDays;
  if (days != null && Number.isInteger(days) && days > 0) {
    return start.plus({ days: days - 1 }).toISODate();
  }
  switch (input.billingFrequency) {
    case 'month':
      return start.plus({ months: 1, days: -1 }).toISODate();
    case 'four_weeks':
    case '4_weeks':
      return start.plus({ days: 27 }).toISODate();
    case 'year':
      return start.plus({ years: 1, days: -1 }).toISODate();
    default:
      return null;
  }
}

/** The end date once a cancellation is recorded on `today`. */
export function endDateOnCancel(validUntil: string | null, today: string): string {
  return validUntil ?? today;
}

export type PurchaseValidityState = 'draft' | 'pending' | 'failed' | 'active' | 'cancelled' | 'expired';

/**
 * A cancelled purchase stays valid through its end date, inclusive; it is
 * `expired` only from the day after. Cancelled and expired are different facts.
 */
export function purchaseValidityState(row: {
  status: string;
  valid_until: string | null;
  cancelled_on: string | null;
}, today: string): PurchaseValidityState {
  if (row.status === 'draft') return 'draft';
  if (row.status === 'pending_payment') return 'pending';
  if (row.status !== 'active') return 'failed';
  if (row.valid_until && row.valid_until < today) return 'expired';
  return row.cancelled_on ? 'cancelled' : 'active';
}

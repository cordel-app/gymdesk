import { advanceBillingDate, BillingDateUnit } from './billingDate';

/**
 * #1196 — what a cancelled Membership still entitles its Member to, and until
 * when. Pure: the SQL that supplies the facts is `api/cancellation-entitlement.ts`.
 *
 * The rule (the owner's 2026-10-11 answer): cancelling changes the status at
 * once, but access follows what was **paid for**. The end date is the last day
 * of the last paid period of the plan's schedule; with nothing paid it is the
 * day before the cancellation (access stops now). A period's end is never
 * invented — a paid period with no stored `period_end` is closed by the
 * schedule's own cadence, and a period that cannot be closed either way is
 * ignored, so the date can only be earlier than the truth, never later.
 */

export interface PaidPeriod {
  /** `YYYY-MM-DD`, the period's first day. */
  periodStart: string;
  /** `YYYY-MM-DD`, the stored last day (inclusive), when the event has one. */
  periodEnd: string | null;
}

export interface ScheduleCadence {
  interval: number;
  unit: BillingDateUnit;
}

const addDays = (date: string, days: number): string => advanceBillingDate(date, days, 'day');

/** The last day of a paid period, or `null` when the records do not establish it. */
export function paidPeriodEnd(period: PaidPeriod, cadence: ScheduleCadence | null): string | null {
  if (period.periodEnd) return period.periodEnd;
  if (!cadence || !(cadence.interval > 0)) return null;
  return addDays(advanceBillingDate(period.periodStart, cadence.interval, cadence.unit), -1);
}

/** The latest last-paid day across the paid periods, or `null` when none is established. */
export function paidThroughDate(periods: readonly PaidPeriod[], cadence: ScheduleCadence | null): string | null {
  let latest: string | null = null;
  for (const p of periods) {
    const end = paidPeriodEnd(p, cadence);
    if (end && (latest === null || end > latest)) latest = end;
  }
  return latest;
}

/**
 * The date the cancelled assignment ends on (inclusive; it keeps entitlement
 * through it). A paid-through date today or later is kept; otherwise access
 * ends now, which is the day before `today` — but never before the plan began.
 */
export function cancellationEndDate(input: { paidThrough: string | null; today: string; assignmentStart: string }): string {
  if (input.paidThrough && input.paidThrough >= input.today) return input.paidThrough;
  const yesterday = addDays(input.today, -1);
  return yesterday < input.assignmentStart ? input.assignmentStart : yesterday;
}

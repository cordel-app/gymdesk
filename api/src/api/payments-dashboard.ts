/**
 * #674: Payments → Dashboard.
 *
 * Read-only aggregation over the Payments domain. Nothing here writes, and no
 * Billing Event or payment-processing behaviour changes — the four cards only
 * count what `billing_events` (past rows) and `user_memberships.next_billing_date`
 * (future, projected rows) already record.
 *
 * Mounted under its own `payments.dashboard` feature flag rather than a sibling
 * page's flag, so the Dashboard survives Transactions or Billing Events being
 * switched off — and can be switched off on its own (issue §Requirements).
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { deriveBillingEventStatus } from '../domain/billingEventStatus';
import { advanceBillingDate } from './billing';
import { ASSIGNMENT_CADENCE } from './assigned-plan-snapshot';

export const paymentsDashboardRouter = Router();

export interface PaymentsDashboardSummary {
  /** First day of the current calendar month, YYYY-MM-DD (UTC). */
  current_month_start: string;
  /** Last day of the current calendar month, YYYY-MM-DD (UTC). */
  current_month_end: string;
  /** First day of the previous calendar month, YYYY-MM-DD (UTC). */
  previous_month_start: string;
  /** Last day of the previous calendar month, YYYY-MM-DD (UTC). */
  previous_month_end: string;
  scheduled_this_month: number;
  total_last_month: number;
  failed_last_month: number;
  successful_last_month: number;
}

export interface MonthWindows {
  today: string;
  currentMonthStart: string;
  currentMonthEnd: string;
  previousMonthStart: string;
  previousMonthEnd: string;
  /** Exclusive upper bound for "this month" — the first day of next month. */
  nextMonthStart: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Calendar-month boundaries around `today` (YYYY-MM-DD, UTC).
 *
 * Derived in JS rather than with MySQL date functions so the SQL ranges and the
 * JS-side projection of scheduled dates below agree on where a month starts —
 * `billing_events.created_at` is stored in UTC and the pool runs at `Z`, so UTC
 * is the one clock both halves can share.
 *
 * Exported for `api/src/test/payments-dashboard.test.ts`, which pins a date
 * rather than waiting for a month boundary to come round.
 */
export function monthWindows(today: string): MonthWindows {
  const d = new Date(`${today}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const currentMonthStart = new Date(Date.UTC(y, m, 1));
  const nextMonthStart = new Date(Date.UTC(y, m + 1, 1));
  const previousMonthStart = new Date(Date.UTC(y, m - 1, 1));
  const dayBefore = (x: Date) => new Date(x.getTime() - 86_400_000);

  return {
    today,
    currentMonthStart: iso(currentMonthStart),
    currentMonthEnd: iso(dayBefore(nextMonthStart)),
    previousMonthStart: iso(previousMonthStart),
    previousMonthEnd: iso(dayBefore(currentMonthStart)),
    nextMonthStart: iso(nextMonthStart),
  };
}

/**
 * GET /payments/dashboard/summary
 *
 * The four cards of the issue, in one round trip:
 *
 * | Card                        | Source                                            |
 * |-----------------------------|---------------------------------------------------|
 * | Scheduled this month        | projected billing dates falling in this month      |
 * | Total last month            | every `billing_events` row created last month      |
 * | Failed last month           | …of those, the ones whose status derives to failed |
 * | Successful last month       | …of those, the ones whose status derives to paid   |
 *
 * "Total" counts every ledger row, which is exactly what the Billing Events
 * page lists — so it is not necessarily `failed + successful`: an `adjustment`
 * or a `status_changed` row is neither.
 */
paymentsDashboardRouter.get('/summary', async (req, res, next) => {
  const { gymId } = getTenantContext(req);

  try {
    const w = monthWindows(new Date().toISOString().slice(0, 10));

    // ── Cards 2-4: last month's ledger rows ──
    //
    // A Billing Event's status is not stored: it is the status of its latest
    // linked Payment Transaction, falling back to the event type (#640,
    // `domain/billingEventStatus.ts`). Grouping by those two inputs in SQL and
    // mapping the groups through the shared pure function keeps the status
    // vocabulary in one place instead of re-spelling it as a CASE expression
    // that could drift from the Billing Events page.
    const { rows: lastMonth } = await db.query<{
      event_type: string; latest_tx_status: string | null; cnt: number | string;
    }>(
      `SELECT e.event_type, e.latest_tx_status, COUNT(*) AS cnt
         FROM (
           SELECT be.event_type,
                  (SELECT pr.status FROM payment_requests pr
                    WHERE pr.billing_event_id = be.id
                    ORDER BY pr.created_at DESC, pr.id DESC
                    LIMIT 1) AS latest_tx_status
             FROM billing_events be
            WHERE be.gym_id = ?
              AND be.created_at >= ?
              AND be.created_at < ?
         ) e
        GROUP BY e.event_type, e.latest_tx_status`,
      [gymId, w.previousMonthStart, w.currentMonthStart],
    );

    let totalLastMonth = 0;
    let failedLastMonth = 0;
    let successfulLastMonth = 0;
    for (const row of lastMonth) {
      const count = Number(row.cnt);
      totalLastMonth += count;
      switch (deriveBillingEventStatus(row.event_type, row.latest_tx_status)) {
        case 'failed': failedLastMonth += count; break;
        case 'paid':   successfulLastMonth += count; break;
        default: break;
      }
    }

    // ── Card 1: billing events scheduled for this month ──
    //
    // A scheduled event has no ledger row yet — the nightly run creates that
    // when it charges. It is projected from the membership's `next_billing_date`
    // and its plan's recurring interval, the same projection the Billing Events
    // page renders as its `scheduled` rows (`api/src/api/payments.ts`), so the
    // card and that page agree on what is scheduled.
    const { rows: activeRows } = await db.query<{
      next_billing_date: Date | string;
      recurring_billing_interval: number;
      recurring_billing_unit: 'day' | 'week' | 'month' | 'year';
    }>(
      `SELECT um.next_billing_date,
              ${ASSIGNMENT_CADENCE.interval()} AS recurring_billing_interval,
              ${ASSIGNMENT_CADENCE.unit()} AS recurring_billing_unit
         FROM user_memberships um
         LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
                                      AND bp.gym_id = um.gym_id
        WHERE um.gym_id = ?
          AND um.status = 'active'
          AND um.next_billing_date IS NOT NULL
          AND ${ASSIGNMENT_CADENCE.interval()} IS NOT NULL
          AND ${ASSIGNMENT_CADENCE.unit()} IS NOT NULL`,
      [gymId],
    );

    let scheduledThisMonth = 0;
    for (const um of activeRows) {
      scheduledThisMonth += countScheduledInWindow(
        um.next_billing_date instanceof Date
          ? um.next_billing_date.toISOString().slice(0, 10)
          : String(um.next_billing_date).slice(0, 10),
        um.recurring_billing_interval,
        um.recurring_billing_unit,
        w,
      );
    }

    const summary: PaymentsDashboardSummary = {
      current_month_start: w.currentMonthStart,
      current_month_end: w.currentMonthEnd,
      previous_month_start: w.previousMonthStart,
      previous_month_end: w.previousMonthEnd,
      scheduled_this_month: scheduledThisMonth,
      total_last_month: totalLastMonth,
      failed_last_month: failedLastMonth,
      successful_last_month: successfulLastMonth,
    };
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * How many billing dates this membership still has inside the current calendar
 * month.
 *
 * Dates before today are skipped rather than counted: an overdue
 * `next_billing_date` is a charge the nightly run has not made yet, and the
 * Billing Events page projects past that same way instead of showing it as
 * still scheduled. So a month whose only billing date has already gone by
 * contributes 0, not 1.
 *
 * Exported for the unit test — pure, with the clock passed in.
 */
export function countScheduledInWindow(
  nextBillingDate: string,
  interval: number,
  unit: 'day' | 'week' | 'month' | 'year',
  w: MonthWindows,
): number {
  if (!nextBillingDate || !interval || interval < 1) return 0;

  // `today` always falls inside the current month, so a date at or after the
  // floor is necessarily at or after the month's first day.
  const floor = nextBillingDate > w.today ? nextBillingDate : w.today;
  let date = nextBillingDate;

  // Catch up to the floor first. A schedule can be arbitrarily overdue — a
  // membership left active while the nightly run was off — so this walk needs
  // far more headroom than the counting loop below; a schedule further behind
  // than that contributes nothing rather than spinning.
  for (let guard = 0; date < floor && guard < 5000; guard++) {
    const advanced = advanceBillingDate(date, interval, unit);
    if (advanced <= date) return 0;
    date = advanced;
  }
  if (date < floor) return 0;

  let count = 0;
  // A daily interval tops out at 31 dates in a month; the cap only guards
  // against a policy row that somehow fails to advance the date.
  for (let guard = 0; guard < 400 && date <= w.currentMonthEnd; guard++) {
    count++;
    const advanced = advanceBillingDate(date, interval, unit);
    if (advanced <= date) break;
    date = advanced;
  }

  return count;
}

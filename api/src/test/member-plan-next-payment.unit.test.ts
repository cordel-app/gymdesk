import { describe, expect, it } from 'vitest';
import { mergeBillingEventForecasts, tagForecastAssignment } from '../api/me-billing-forecast';
import {
  type BillingEventForecast,
  planNextPayment,
  productNextPayment,
} from '../../../apps/member/src/lib/memberPayments';

// #3235 — a plan or Product card in My Products shows the next scheduled payment
// it is part of, found through the forecast's assignment tag.

const line = (kind: 'membership_fee' | 'product', productId: number | null, amount: number) => ({
  kind, label: 'x', product_id: productId, mandatory: false, quantity: 1, unit_price: amount,
  regular_price: amount, actual_charge: amount, prepaid_periods: null, prepaid_cadence: null, benefits: [],
});

const result = (dates: { date: string; lines: ReturnType<typeof line>[] }[]) => ({
  available: true, reason: null, currency: 'EUR' as const, anchor_date: dates[0]?.date ?? null,
  horizon_date: null, tax_included: true, truncated: false,
  dates: dates.map((d) => ({ ...d, total: d.lines.reduce((s, l) => s + l.actual_charge, 0), cycle: null })),
  total: 0, cycle: null,
}) as any;

describe('tagForecastAssignment + merge', () => {
  it('names the assignment on every line and keeps it through the merge by date', () => {
    const a = tagForecastAssignment(result([{ date: '2026-12-01', lines: [line('membership_fee', null, 40)] }]), 7);
    const b = tagForecastAssignment(result([
      { date: '2026-12-01', lines: [line('membership_fee', null, 30)] },
      { date: '2027-01-01', lines: [line('membership_fee', null, 30), line('product', 9, 5)] },
    ]), 8);
    const merged = mergeBillingEventForecasts([a, b]) as unknown as BillingEventForecast;
    expect(merged.dates[0].total).toBe(70);
    expect(merged.dates[0].lines.map((l) => l.user_membership_id)).toEqual([7, 8]);

    // The plan's next payment is the whole payment it is part of, not its own line.
    expect(planNextPayment(merged, 8)?.date).toBe('2026-12-01');
    expect(planNextPayment(merged, 8)?.total).toBe(70);
    expect(productNextPayment(merged, 9)?.date).toBe('2027-01-01');
  });

  it('answers null with no assignment, no match or no forecast', () => {
    const f = tagForecastAssignment(result([{ date: '2026-12-01', lines: [line('membership_fee', null, 40)] }]), 7) as BillingEventForecast;
    expect(planNextPayment(f, null)).toBeNull();
    expect(planNextPayment(f, 99)).toBeNull();
    expect(productNextPayment(f, 3)).toBeNull();
    expect(planNextPayment({ ...f, available: false }, 7)).toBeNull();
  });
});

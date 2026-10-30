// #2125 — a member with several live plans reads one forecast: same-day
// billing dates are one group, nothing is re-priced.
import { describe, expect, it } from 'vitest';
import { mergeBillingEventForecasts } from '../api/me-billing-forecast';
import { emptyBillingEventSimulation } from '../domain/billingEventSimulation';

const line = (label: string, amount: number) => ({ kind: 'membership_fee', label, amount } as any);
function forecast(dates: Array<[string, number]>, over: Record<string, unknown> = {}): any {
  return {
    ...emptyBillingEventSimulation('x'), available: true, reason: null, anchor_date: '2026-01-01', horizon_date: '2026-12-01',
    dates: dates.map(([date, total]) => ({ date, total, lines: [line(`fee ${date}`, total)], cycle: null })),
    total: dates.reduce((s, [, t]) => s + t, 0), ...over,
  };
}

describe('mergeBillingEventForecasts', () => {
  it('returns a single forecast untouched', () => {
    const one = forecast([['2026-11-01', 30]]);
    expect(mergeBillingEventForecasts([one])).toBe(one);
  });

  it('groups the same date across plans and sums the totals', () => {
    const merged = mergeBillingEventForecasts([
      forecast([['2026-11-01', 30], ['2026-12-01', 30]]),
      forecast([['2026-11-01', 10.5], ['2026-11-15', 5]], { horizon_date: '2027-01-01' }),
    ]);
    expect(merged.dates.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-15', '2026-12-01']);
    expect(merged.dates[0].total).toBe(40.5);
    expect(merged.dates[0].lines).toHaveLength(2);
    expect(merged.total).toBe(75.5);
    expect(merged.horizon_date).toBe('2027-01-01');
  });

  it('ignores an unavailable projection when another plan has one', () => {
    const one = forecast([['2026-11-01', 30]]);
    expect(mergeBillingEventForecasts([emptyBillingEventSimulation('none'), one])).toBe(one);
  });
});

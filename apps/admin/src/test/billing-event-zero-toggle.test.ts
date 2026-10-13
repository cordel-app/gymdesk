import { describe, expect, it } from 'vitest';
import { isZeroAmount, visibleBillingDates } from '@/lib/billingEventSimulation';

describe('#1536 zero-amount billing events toggle', () => {
  const dates = [
    { date: '2026-11-01', total: 0 },
    { date: '2026-12-01', total: 29.99 },
    { date: '2027-01-01', total: 0.0 },
  ];

  it('hides dates whose final total is exactly 0.00 when OFF', () => {
    expect(visibleBillingDates(dates, false).map((d) => d.date)).toEqual(['2026-12-01']);
  });

  it('lists every date when ON', () => {
    expect(visibleBillingDates(dates, true)).toHaveLength(3);
  });

  it('only an exact zero counts', () => {
    expect(isZeroAmount(0)).toBe(true);
    expect(isZeroAmount(0.01)).toBe(false);
    expect(isZeroAmount(null)).toBe(false);
  });
});

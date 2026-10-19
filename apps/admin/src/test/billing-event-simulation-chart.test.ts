import { describe, expect, it } from 'vitest';
import {
  billingDateAtX, billingDateToX, billingEventChartPoints, selectedBillingGroup, visibleBillingDates,
} from '@/lib/billingEventSimulation';

const group = (date: string, total: number) => ({ date, total, lines: [] });
const fmtD = (d: string) => `D${d}`;
const fmtA = (a: number) => `€${a.toFixed(2)}`;

describe('billing event chart (#1808)', () => {
  it('plots one chronological point per date with the server total', () => {
    const points = billingEventChartPoints(
      [group('2026-03-01', 10), group('2026-01-01', 5.5)], fmtD, fmtA,
    );
    expect(points.map((p) => p.date)).toEqual(['2026-01-01', '2026-03-01']);
    expect(points.map((p) => p.y)).toEqual([5.5, 10]);
    expect(points[0].valueLabel).toBe('€5.50');
  });

  it('keeps zero and negative totals and skips unparseable dates', () => {
    const points = billingEventChartPoints(
      [group('2026-01-01', 0), group('2026-02-01', -3), group('nope', 1)], fmtD, fmtA,
    );
    expect(points.map((p) => p.y)).toEqual([0, -3]);
  });

  it('handles empty and single-date simulations', () => {
    expect(billingEventChartPoints([], fmtD, fmtA)).toEqual([]);
    expect(billingEventChartPoints([group('2026-01-01', 1)], fmtD, fmtA)).toHaveLength(1);
  });

  it('maps a clicked x back to its date and selects its group', () => {
    const dates = [group('2026-01-01', 1), group('2026-02-01', 2)];
    const points = billingEventChartPoints(dates, fmtD, fmtA);
    const date = billingDateAtX(points, billingDateToX('2026-02-01')!);
    expect(date).toBe('2026-02-01');
    expect(selectedBillingGroup(dates, date)?.total).toBe(2);
    expect(selectedBillingGroup(dates, '2030-01-01')).toBeNull();
    expect(selectedBillingGroup(dates, null)).toBeNull();
    expect(billingDateAtX(points, 1)).toBeNull();
  });

  it('follows the Show €0 option on the Membership Plans chart (#1810)', () => {
    const dates = [group('2026-01-01', 0), group('2026-02-01', 4)];
    const hidden = billingEventChartPoints(visibleBillingDates(dates, false), fmtD, fmtA);
    const shown = billingEventChartPoints(visibleBillingDates(dates, true), fmtD, fmtA);
    expect(hidden.map((p) => p.y)).toEqual([4]);
    expect(shown.map((p) => p.y)).toEqual([0, 4]);
  });
});

describe('billing event chart point details (#1808)', () => {
  it('lists each billing item with its final price and the total', () => {
    const line = (label: string, actual_charge: number) => ({
      kind: 'product' as const, label, product_id: 1, mandatory: false, quantity: 1,
      unit_price: actual_charge, regular_price: actual_charge, actual_charge, prepaid_periods: null, benefits: [],
    });
    const [p] = billingEventChartPoints(
      [{ date: '2027-10-19', total: 35, lines: [line('Membership Plan', 20), line('Personal Training', 15)] } as never],
      fmtD, fmtA, undefined, (t) => `Total: ${t}`,
    );
    expect(p.detailLines).toEqual(['Membership Plan — €20.00', 'Personal Training — €15.00']);
    expect(p.valueLabel).toBe('Total: €35.00');
  });
});

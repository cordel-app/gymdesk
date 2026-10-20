import { describe, it, expect } from 'vitest';
import { composeDraftSimulation } from '../domain/draftBillingSimulation';
import type { BillingEventLine, BillingEventSimulationResult } from '../domain/billingEventSimulation';

const line = (label: string, charge: number): BillingEventLine => ({
  kind: 'product', label, product_id: 1, mandatory: false, quantity: 1,
  unit_price: charge, regular_price: charge, actual_charge: charge, prepaid_periods: null, benefits: [],
});
const group = (date: string, lines: BillingEventLine[]) => ({
  date, lines, total: lines.reduce((s, l) => s + l.actual_charge, 0), cycle: null,
});
const base = (dates: ReturnType<typeof group>[]): BillingEventSimulationResult => ({
  available: dates.length > 0, reason: null, currency: 'EUR', anchor_date: '2026-10-20',
  horizon_date: '2026-12-20', tax_included: true, truncated: false, cycle: null,
  dates, total: dates.reduce((s, d) => s + d.total, 0),
});

describe('composeDraftSimulation (#1867 stage 2)', () => {
  it('counts the initial payment once when the engine already holds that date', () => {
    const fee = line('Fee', 50);
    const out = composeDraftSimulation({
      base: base([group('2026-10-20', [fee]), group('2026-11-20', [fee])]),
      initial: { date: '2026-10-20', lines: [fee] }, oneOffs: [], today: '2026-10-20',
    });
    expect(out.total).toBe(100);
    expect(out.dates.map((d) => d.kind)).toEqual(['initial_payment', 'scheduled']);
  });

  it('replaces the date with the delta owed when the Draft replaces a running version', () => {
    const out = composeDraftSimulation({
      base: base([group('2026-11-05', [line('Fee', 50), line('Locker', 10)])]),
      initial: { date: '2026-10-20', lines: [line('Locker (prorated)', 4)] }, oneOffs: [], today: '2026-10-20',
    });
    expect(out.dates.map((d) => [d.date, d.total, d.kind])).toEqual([
      ['2026-10-20', 4, 'initial_payment'], ['2026-11-05', 60, 'scheduled'],
    ]);
    expect(out.total).toBe(64);
  });

  it('puts pending one-offs on today and keeps the totals reconciled', () => {
    const out = composeDraftSimulation({
      base: base([group('2026-10-20', [line('Fee', 50)])]),
      initial: { date: '2026-10-20', lines: [line('Fee', 50)] },
      oneOffs: [{ product_id: 7, name: 'Towel', amount: 8, list_price: 10 }], today: '2026-10-20',
    });
    expect(out.dates).toHaveLength(1);
    expect(out.dates[0].total).toBe(58);
    expect(out.dates[0].lines[1]).toMatchObject({ label: 'Towel', regular_price: 10, actual_charge: 8 });
    expect(out.total).toBe(58);
  });

  it('is available with only a one-off and no recurring schedule', () => {
    const out = composeDraftSimulation({
      base: { ...base([]), available: false, reason: 'nothing' }, initial: null,
      oneOffs: [{ product_id: 7, name: 'Towel', amount: 8, list_price: null }], today: '2026-10-20',
    });
    expect(out.available).toBe(true);
    expect(out.total).toBe(8);
  });
});

// #3167 — a recurring line that starts before its shared schedule's anchor (a Product added today
// beside a plan whose schedule opens later) still joins that schedule's calendar, and the Draft
// forecast lists the initial payment's covered dates once.
import { describe, expect, it } from 'vitest';
import { rewindAnchor } from '../domain/billingSimulation';
import { composeDraftSimulation } from '../domain/draftBillingSimulation';

describe('rewindAnchor', () => {
  it('steps a monthly anchor back to the last 1st on or before the start', () => {
    expect(rewindAnchor('2026-12-01', '2026-11-22', { interval: 1, unit: 'month' })).toBe('2026-11-01');
  });
  it('stays on the 28-day grid anchored on 2026-11-02', () => {
    // 2026-12-28 is a grid date (2026-11-02 + 56 days); a start on 2026-11-22 rewinds to 2026-11-02.
    expect(rewindAnchor('2026-12-28', '2026-11-22', { interval: 4, unit: 'week' })).toBe('2026-11-02');
  });
  it('keeps an anchor already on or before the start', () => {
    expect(rewindAnchor('2026-11-01', '2026-11-22', { interval: 1, unit: 'month' })).toBe('2026-11-01');
    expect(rewindAnchor('2026-11-22', '2026-11-22', { interval: 1, unit: 'month' })).toBe('2026-11-22');
  });
});

describe('composeDraftSimulation with covered dates', () => {
  const line = (label: string, amount: number) => ({ label, actual_charge: amount } as any);
  it('replaces the groups of every date the initial payment covers', () => {
    const result = composeDraftSimulation({
      base: {
        available: true, reason: null, anchor_date: null, horizon_date: null, total: 0,
        dates: [
          { date: '2026-11-22', lines: [line('Trainer', 9)], total: 9, cycle: null },
          { date: '2026-12-01', lines: [line('Trainer', 31)], total: 31, cycle: null },
          { date: '2026-12-15', lines: [line('Fee', 22)], total: 22, cycle: null },
        ],
      } as any,
      initial: { date: '2026-11-22', lines: [line('Fee', 22), line('Trainer', 9)], coveredDates: ['2026-11-22', '2026-12-15'] },
      oneOffs: [],
      today: '2026-11-22',
    });
    expect(result.dates.map((d) => [d.date, d.kind])).toEqual([
      ['2026-11-22', 'initial_payment'], ['2026-12-01', 'scheduled'],
    ]);
  });
});

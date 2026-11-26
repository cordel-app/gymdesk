// #3445 stage 2 — the rolling window is the Product Set's: two distinct positive billing dates
// across every schedule, every positive obligation on those dates kept.
import { describe, expect, it } from 'vitest';
import { primaryScheduleIndex, selectGlobalWindow, type WindowBucket } from '../domain/billingWindow';

const b = (scheduleKey: string | null, date: string, amount: number, stub = false): WindowBucket =>
  ({ scheduleKey, date, amount, stub });

describe('selectGlobalWindow', () => {
  it('keeps the first two distinct dates across schedules, not two per schedule', () => {
    const buckets = [
      b('plan', '2026-12-01', 50), b('plan', '2027-01-01', 50), b('plan', '2027-02-01', 50),
      b('locker', '2026-12-28', 10), b('locker', '2027-01-25', 10),
    ];
    const out = selectGlobalWindow(buckets, 2);
    expect(out.dates).toEqual(['2026-12-01', '2026-12-28']);
    expect(out.kept).toEqual([0, 3]);
    expect(out.short).toBe(false);
  });

  it('a date where two schedules coincide holds one slot and keeps both obligations', () => {
    const out = selectGlobalWindow([
      b('plan', '2026-12-01', 50), b('locker', '2026-12-01', 10), b('plan', '2027-01-01', 50), b('locker', '2027-01-29', 10),
    ], 2);
    expect(out.dates).toEqual(['2026-12-01', '2027-01-01']);
    expect(out.kept).toEqual([0, 1, 2]);
  });

  it('a zero-value obligation holds no slot and is dropped, a one-off and a stub are always kept', () => {
    const out = selectGlobalWindow([
      b('plan', '2026-12-01', 0), b(null, '2026-12-01', 5), b('locker', '2026-12-03', 4, true),
      b('plan', '2027-01-01', 50), b('plan', '2027-02-01', 50), b('plan', '2027-03-01', 50),
    ], 2);
    expect(out.dates).toEqual(['2027-01-01', '2027-02-01']);
    expect(out.kept).toEqual([1, 2, 3, 4]);
  });

  it('reports a short window when the contract has fewer positive dates', () => {
    const out = selectGlobalWindow([b('plan', '2026-12-01', 50), b('plan', '2027-01-01', 0)], 2);
    expect(out.dates).toEqual(['2026-12-01']);
    expect(out.short).toBe(true);
  });
});

describe('primaryScheduleIndex', () => {
  it('files a consolidated event under the plan schedule, else the oldest schedule', () => {
    expect(primaryScheduleIndex([{ scheduleKey: 'locker', scheduleId: 3 }, { scheduleKey: 'plan', scheduleId: 9 }], 'plan')).toBe(1);
    expect(primaryScheduleIndex([{ scheduleKey: 'b', scheduleId: 7 }, { scheduleKey: 'a', scheduleId: 4 }], 'plan')).toBe(1);
  });
});

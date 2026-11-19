import { describe, it, expect } from 'vitest';
import { firstCycleEvents } from '../api/product-set-checkout';

const ev = (date: string, scheduleKey: string | null) => ({ date, scheduleKey });

describe('firstCycleEvents (#3046)', () => {
  it('keeps events on the start date', () => {
    expect(firstCycleEvents([ev('2026-11-10', 'plan')], '2026-11-10', '2026-11-19')).toHaveLength(1);
  });
  it('includes a yearly line added after the Draft was created (due today)', () => {
    const r = firstCycleEvents([ev('2026-11-19', 'year'), ev('2027-11-19', 'year')], '2026-11-10', '2026-11-19');
    expect(r.map((e) => e.date)).toEqual(['2026-11-19']);
  });
  it('does not include a future event or a later cycle of a schedule already charged', () => {
    expect(firstCycleEvents([ev('2026-12-01', 'month')], '2026-11-10', '2026-11-19')).toEqual([]);
    const r = firstCycleEvents([ev('2026-11-10', 'plan'), ev('2026-11-15', 'plan')], '2026-11-10', '2026-11-19');
    expect(r).toHaveLength(1);
  });
});

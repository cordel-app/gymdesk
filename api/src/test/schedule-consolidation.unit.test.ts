// #2125 M5c-2 — which schedules of a chain are one schedule, which one they
// consolidate into, and what happens to each event of the one that goes away.
import { describe, expect, it } from 'vitest';
import {
  classifyMergedEvent, consolidationGroups, findScheduleWithIdentity, sameScheduleIdentity,
  type ConsolidatableSchedule, type ConsolidationEvent,
} from '../domain/scheduleConsolidation';

const sch = (id: number, key: string, anchorDate: string, interval: number, unit: string): ConsolidatableSchedule =>
  ({ id, key, anchorDate, cadence: { interval, unit } });

describe('sameScheduleIdentity', () => {
  it('a grid cadence is one schedule whatever its anchor; a yearly one only on the same anniversary', () => {
    expect(sameScheduleIdentity(sch(1, 'plan', '2026-10-01', 1, 'month'), sch(2, 's1', '2026-11-01', 1, 'month'))).toBe(true);
    expect(sameScheduleIdentity(sch(1, 'plan', '2026-11-02', 4, 'week'), sch(2, 's1', '2026-11-30', 4, 'week'))).toBe(true);
    expect(sameScheduleIdentity(sch(1, 'plan', '2026-11-02', 1, 'week'), sch(2, 's1', '2026-11-09', 1, 'week'))).toBe(true);
    expect(sameScheduleIdentity(sch(1, 'plan', '2026-03-15', 1, 'year'), sch(2, 's1', '2026-05-20', 1, 'year'))).toBe(false);
    expect(sameScheduleIdentity(sch(1, 'plan', '2026-03-15', 1, 'year'), sch(2, 's1', '2026-03-15', 1, 'year'))).toBe(true);
    expect(sameScheduleIdentity(sch(1, 'plan', '2026-11-02', 1, 'week'), sch(2, 's1', '2026-11-02', 4, 'week'))).toBe(false);
  });
});

describe('consolidationGroups', () => {
  it('folds into the plan schedule when the group holds it, else the oldest', () => {
    const groups = consolidationGroups([
      sch(5, 's1', '2026-10-01', 1, 'month'),
      sch(7, 'plan', '2026-11-01', 1, 'month'),
      sch(9, 's3', '2026-11-01', 1, 'month'),
      sch(10, 's4', '2026-11-02', 1, 'week'),
      sch(11, 's5', '2026-11-09', 1, 'week'),
      sch(12, 's6', '2026-03-15', 1, 'year'),
      sch(13, 's7', '2026-05-20', 1, 'year'),
    ]);
    expect(groups).toEqual([
      { targetId: 7, mergedIds: [5, 9] },
      { targetId: 10, mergedIds: [11] },
    ]);
  });

  it('has nothing to do for distinct cadences', () => {
    expect(consolidationGroups([sch(1, 'plan', '2026-11-01', 1, 'month'), sch(2, 's1', '2026-11-02', 4, 'week')])).toEqual([]);
  });
});

describe('findScheduleWithIdentity', () => {
  it('finds the oldest schedule a new one would be', () => {
    const existing = [sch(4, 's2', '2026-09-01', 1, 'month'), sch(3, 's1', '2026-10-01', 1, 'month')];
    expect(findScheduleWithIdentity(existing, { anchorDate: '2026-11-01', cadence: { interval: 1, unit: 'month' } })?.id).toBe(3);
    expect(findScheduleWithIdentity(existing, { anchorDate: '2026-11-01', cadence: { interval: 1, unit: 'year' } })).toBeNull();
  });
});

describe('classifyMergedEvent', () => {
  const TODAY = '2026-11-11';
  const ev = (over: Partial<ConsolidationEvent> = {}): ConsolidationEvent =>
    ({ periodStart: '2026-12-01', billingDate: '2026-12-01', isScheduled: true, attempted: false, ...over });

  it('moves an event with no counterpart on the target', () => {
    expect(classifyMergedEvent(ev(), null, TODAY)).toBe('repoint');
    expect(classifyMergedEvent(ev({ periodStart: null }), ev(), TODAY)).toBe('repoint');
  });

  it('regenerates two colliding untouched future obligations', () => {
    expect(classifyMergedEvent(ev(), ev(), TODAY)).toBe('regenerate');
  });

  it('keeps a collision that has history: attempted, past, today or not an obligation', () => {
    expect(classifyMergedEvent(ev({ attempted: true }), ev(), TODAY)).toBe('keep');
    expect(classifyMergedEvent(ev(), ev({ attempted: true }), TODAY)).toBe('keep');
    expect(classifyMergedEvent(ev({ periodStart: '2026-11-01', billingDate: '2026-11-01' }),
      ev({ periodStart: '2026-11-01', billingDate: '2026-11-01' }), TODAY)).toBe('keep');
    expect(classifyMergedEvent(ev({ billingDate: TODAY }), ev({ billingDate: TODAY }), TODAY)).toBe('keep');
    expect(classifyMergedEvent(ev({ isScheduled: false }), ev(), TODAY)).toBe('keep');
  });
});

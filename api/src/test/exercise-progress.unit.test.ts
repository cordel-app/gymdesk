import { describe, expect, it } from 'vitest';
import {
  bestResult, daysExercised, defaultResultType, maxWeight, progressDays, summarizeExercise,
  type ProgressLog,
} from '../domain/exerciseProgress';

const log = (d: string, sets: Array<[number | null, number | null]>, extra: Partial<ProgressLog> = {}): ProgressLog => ({
  logged_date: d, duration_seconds: null, skipped: false,
  sets: sets.map(([weight, reps], i) => ({ set_number: i + 1, weight, reps })), ...extra,
});

const WEIGHT = { id: 2, slug: 'weight' };
const REPS = { id: 1, slug: 'repetitions' };
const DURATION = { id: 4, slug: 'duration' };

describe('exercise progress (#1224)', () => {
  const logs = [
    log('2026-10-01', [[60, 10], [65, 8]]),
    log('2026-10-01', [[70, 5]]),
    log('2026-10-05', [[null, 12]]),
    log('2026-10-07', [[200, 1]], { skipped: true }),
  ];

  it('counts distinct performed dates and ignores skipped logs', () => {
    expect(daysExercised(logs)).toBe(2);
    expect(maxWeight(logs)).toBe(70);
  });

  it('reads the best result in the exercise result type only', () => {
    expect(bestResult(logs, WEIGHT)).toEqual({ slug: 'weight', value: 70 });
    expect(bestResult(logs, REPS)).toEqual({ slug: 'repetitions', value: 12 });
    expect(bestResult([log('2026-10-01', [], { duration_seconds: 90 }), log('2026-10-02', [], { duration_seconds: 120 })], DURATION))
      .toEqual({ slug: 'duration', value: 120 });
  });

  it('has no best result for an unmeasured type, no type or no data', () => {
    expect(bestResult(logs, { id: 5, slug: 'pace' })).toBeNull();
    expect(bestResult(logs, null)).toBeNull();
    expect(bestResult([log('2026-10-01', [[null, null]])], WEIGHT)).toBeNull();
  });

  it('defaults to the only allowed type, else the first by id, else none', () => {
    expect(defaultResultType([WEIGHT])).toEqual(WEIGHT);
    expect(defaultResultType([WEIGHT, REPS])).toEqual(REPS);
    expect(defaultResultType([])).toBeNull();
  });

  it('builds one chart point per date, oldest first', () => {
    const days = progressDays(logs, WEIGHT);
    expect(days.map((d) => d.logged_date)).toEqual(['2026-10-01', '2026-10-05']);
    expect(days[0].value).toBe(70);
    expect(days[0].sets).toHaveLength(3);
    expect(days[1].value).toBeNull();
  });

  it('summarizes with no allowed types as an empty best result', () => {
    const s = summarizeExercise(logs, []);
    expect(s.best_result).toBeNull();
    expect(s.max_weight).toBe(70);
  });

  it('numbers the sets of a day sequentially across registrations (#1773)', () => {
    const days = progressDays([
      log('2026-10-01', [[60, 10]]), log('2026-10-01', [[65, 8]]), log('2026-10-01', [[70, 5]]),
      log('2026-10-02', [[60, 10]]),
    ], WEIGHT);
    expect(days[0].sets.map((s) => s.set_number)).toEqual([1, 2, 3]);
    expect(days[1].sets.map((s) => s.set_number)).toEqual([1]);
  });
});

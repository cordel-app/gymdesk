import { describe, expect, it } from 'vitest';
import { mealsCompletionStatus, mealsStatusKey, mealsStatusTone } from '../lib/homeMealsStatus';

const DAY = '2026-11-27';

describe('mealsCompletionStatus (#3545)', () => {
  it('is Not Started when no meal of today has a log', () => {
    expect(mealsCompletionStatus([1, 2], [{ meal_id: 1, logged_date: '2026-11-26', level: 'done' }], DAY)).toBe('not_started');
  });

  it('is Partially Done when some meals are logged but not all fully done', () => {
    expect(mealsCompletionStatus([1, 2], [{ meal_id: 1, logged_date: DAY, level: 'done' }], DAY)).toBe('partial');
    expect(mealsCompletionStatus([1], [{ meal_id: 1, logged_date: DAY, level: 'partial' }], DAY)).toBe('partial');
  });

  it('is Fully Done when every meal is fully done (a log with no level counts as done)', () => {
    expect(mealsCompletionStatus([1, 2], [
      { meal_id: 1, logged_date: DAY, level: 'done' },
      { meal_id: 2, logged_date: `${DAY}T00:00:00Z` },
    ], DAY)).toBe('done');
  });

  it('ignores logs of meals outside today', () => {
    expect(mealsCompletionStatus([1], [{ meal_id: 9, logged_date: DAY, level: 'done' }], DAY)).toBe('not_started');
  });

  it('maps each state to its label key and existing tone', () => {
    expect(['not_started', 'partial', 'done'].map((s) => mealsStatusKey(s as any))).toEqual(['not_started', 'partially_done', 'fully_done']);
    expect(mealsStatusTone('done')).toBe('success');
    expect(mealsStatusTone('partial')).toBe('warning');
    expect(mealsStatusTone('not_started')).toBe('neutral');
  });
});

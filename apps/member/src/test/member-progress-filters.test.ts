import { describe, expect, it } from 'vitest';
import {
  NO_PROGRESS_FILTERS, filterProgress, gymToday, progressMuscles, type ProgressSummary,
} from '../lib/memberProgress';

const item = (id: number, last: string | null, muscles: string[]): ProgressSummary => ({
  exercise_id: id, exercise_name: `E${id}`, image_url: null, image_thumbnail_url: null,
  last_logged_date: last, muscles, days_exercised: 1, max_weight: null, result_kind: null, best_result: null,
});
const items = [
  item(1, '2026-11-02', ['chest']),
  item(2, '2026-10-30', ['back', 'biceps']),
  item(3, '2026-10-10', ['chest']),
  item(4, null, []),
];
const today = '2026-11-02';

describe('filterProgress (#2284)', () => {
  it('keeps everything by default', () => {
    expect(filterProgress(items, NO_PROGRESS_FILTERS, today)).toHaveLength(4);
  });
  it('filters by exercise and by muscle', () => {
    expect(filterProgress(items, { ...NO_PROGRESS_FILTERS, exerciseId: 2 }, today).map((i) => i.exercise_id)).toEqual([2]);
    expect(filterProgress(items, { ...NO_PROGRESS_FILTERS, muscle: 'chest' }, today).map((i) => i.exercise_id)).toEqual([1, 3]);
  });
  it('uses the last 7 / 30 days off the last recording', () => {
    expect(filterProgress(items, { ...NO_PROGRESS_FILTERS, range: 'week' }, today).map((i) => i.exercise_id)).toEqual([1, 2]);
    expect(filterProgress(items, { ...NO_PROGRESS_FILTERS, range: 'month' }, today).map((i) => i.exercise_id)).toEqual([1, 2, 3]);
  });
  it('combines filters and can end empty', () => {
    expect(filterProgress(items, { exerciseId: null, muscle: 'chest', range: 'week' }, today).map((i) => i.exercise_id)).toEqual([1]);
    expect(filterProgress(items, { exerciseId: 3, muscle: null, range: 'week' }, today)).toEqual([]);
  });
  it('lists the muscles present', () => {
    expect(progressMuscles(items)).toEqual(['back', 'biceps', 'chest']);
  });
  it('reads today in the gym time zone', () => {
    const now = new Date('2026-11-02T23:30:00Z');
    expect(gymToday(now, 'Europe/Madrid')).toBe('2026-11-03');
    expect(gymToday(now, 'UTC')).toBe('2026-11-02');
  });
});

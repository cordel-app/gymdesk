import { describe, it, expect } from 'vitest';
import { clampIndex, dayStatus } from '../lib/trainingDayStatus';

const workouts = [{ scheduled_weekday: 2, blocks: [{ id: 1 }, { id: 2 }] }]; // Tuesday
const today = '2026-10-14'; // Wednesday

describe('dayStatus (#1527)', () => {
  it('is rest when nothing is scheduled that weekday', () => {
    expect(dayStatus('2026-10-14', 3, today, workouts, [])).toBe('rest');
  });
  it('is completed only when every block of the workout is logged that date', () => {
    const one = [{ workout_block_id: 1, logged_date: '2026-10-13' }];
    expect(dayStatus('2026-10-13', 2, today, workouts, one)).toBe('pending');
    const both = [...one, { workout_block_id: 2, logged_date: '2026-10-13T00:00:00.000Z' }];
    expect(dayStatus('2026-10-13', 2, today, workouts, both)).toBe('completed');
  });
  it('does not count a log from another date', () => {
    const other = [{ workout_block_id: 1, logged_date: '2026-10-06' }, { workout_block_id: 2, logged_date: '2026-10-06' }];
    expect(dayStatus('2026-10-13', 2, today, workouts, other)).toBe('pending');
  });
  it('is scheduled in the future and pending today', () => {
    expect(dayStatus('2026-10-20', 2, today, workouts, [])).toBe('scheduled');
    expect(dayStatus('2026-10-14', 3, today, [{ scheduled_weekday: 3, blocks: [{ id: 9 }] }], [])).toBe('pending');
  });
  it('needs every workout of the day done, and a workout with no blocks is never done', () => {
    const two = [...workouts, { scheduled_weekday: 2, blocks: [{ id: 3 }] }];
    const logs = [1, 2].map((id) => ({ workout_block_id: id, logged_date: '2026-10-13' }));
    expect(dayStatus('2026-10-13', 2, today, two, logs)).toBe('pending');
    expect(dayStatus('2026-10-13', 2, today, [{ scheduled_weekday: 2, blocks: [] }], [])).toBe('pending');
  });
  it('clamps the carousel position', () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(1, 0)).toBe(0);
  });
});

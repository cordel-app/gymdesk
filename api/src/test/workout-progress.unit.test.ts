import { describe, it, expect } from 'vitest';
import { gymToday, isFutureLoggedDate, trainingProgress } from '../domain/workoutProgress';

describe('workoutProgress (#1370)', () => {
  it('uses the gym zone for today', () => {
    const now = new Date('2026-10-10T23:30:00Z');
    expect(gymToday(now, 'Europe/Madrid')).toBe('2026-10-11');
    expect(isFutureLoggedDate('2026-10-11', now, 'Europe/Madrid')).toBe(false);
    expect(isFutureLoggedDate('2026-10-11', now, 'UTC')).toBe(true);
    expect(isFutureLoggedDate('2026-10-09', now, 'UTC')).toBe(false);
  });
  it('counts day/week/month, excluding future days, 0% when total is 0', () => {
    // 2026-10-14 is a Wednesday (weekday 3)
    const w = [{ id: 1, weekday: 1, blockIds: [10, 11] }, { id: 2, weekday: 3, blockIds: [20] }];
    const logs = [
      { blockId: 10, date: '2026-10-12' }, { blockId: 11, date: '2026-10-12' },
      { blockId: 20, date: '2026-10-14' },
    ];
    const p = trainingProgress(w, logs, '2026-10-14', 1);
    expect(p.day).toEqual({ completed: 1, total: 1, percent: 100 });
    expect(p.week).toEqual({ completed: 2, total: 2, percent: 100 });
    expect(p.month.total).toBe(4); // Mondays 5,12 + Wednesdays 7,14
    expect(p.month.completed).toBe(2);
    expect(trainingProgress([], [], '2026-10-14').day.percent).toBe(0);
  });
  it('a workout is not done with a block missing', () => {
    const p = trainingProgress([{ id: 1, weekday: 3, blockIds: [1, 2] }], [{ blockId: 1, date: '2026-10-14' }], '2026-10-14');
    expect(p.day.completed).toBe(0);
  });
});

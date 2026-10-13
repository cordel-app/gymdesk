import { describe, it, expect } from 'vitest';
import { gymToday, trainingProgress } from '../domain/workoutProgress';

describe('workoutProgress (#1370)', () => {
  it('uses the gym zone for today', () => {
    const now = new Date('2026-10-10T23:30:00Z');
    expect(gymToday(now, 'Europe/Madrid')).toBe('2026-10-11');
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
    // Last 30 days = 09-15..10-14: Mondays 9/21,9/28,10/5,10/12 + Wednesdays 9/16,9/23,9/30,10/7,10/14
    expect(p.month.total).toBe(9);
    expect(p.month.completed).toBe(2);
    expect(trainingProgress([], [], '2026-10-14').day.percent).toBe(0);
  });
  it('a workout is not done with a block missing', () => {
    const p = trainingProgress([{ id: 1, weekday: 3, blockIds: [1, 2] }], [{ blockId: 1, date: '2026-10-14' }], '2026-10-14');
    expect(p.day.completed).toBe(0);
  });
});

describe('trainingProgress for a selected date (#1370 stage 2)', () => {
  // Mondays (weekday 1) in Oct 2026: 5, 12, 19, 26
  const w = [{ id: 1, weekday: 1, blockIds: [1] }];
  const logs = [{ blockId: 1, date: '2026-10-05' }, { blockId: 1, date: '2026-10-12' }];
  it('uses rolling 7 and 30 day windows ending on the selected date (#1524)', () => {
    const p = trainingProgress(w, logs, '2026-10-14', 1, '2026-10-05');
    expect(p.day).toEqual({ completed: 1, total: 1, percent: 100 });
    // Last 7 days = 09-29..10-05: only Monday 10/5 (9/28 is out)
    expect(p.week).toEqual({ completed: 1, total: 1, percent: 100 });
    // Last 30 days = 09-06..10-05: Mondays 9/7,14,21,28 and 10/5
    expect(p.month.total).toBe(5);
    expect(p.month.completed).toBe(1);
  });
  it('a future selected day counts its own workouts (#1549), a future week none', () => {
    const p = trainingProgress(w, logs, '2026-10-14', 1, '2026-10-19');
    expect(p.day).toEqual({ completed: 0, total: 1, percent: 0 });
    expect(p.week.total).toBe(0);
    expect(p.month.total).toBe(4); // window capped at today: 09-20..10-14
  });
  it('the window includes both boundary days (#1524)', () => {
    const wed = [{ id: 1, weekday: 3, blockIds: [1] }];
    // 7 days ending Wed 10-14 start Thu 10-08, so Wed 10-07 is out and 10-14 is in
    expect(trainingProgress(wed, [], '2026-10-14').week.total).toBe(1);
    // 30 days ending 10-14 start 09-15: Wed 9/16 in, Wed 9/9 out
    expect(trainingProgress(wed, [], '2026-10-14').month.total).toBe(5);
  });
  it('a past date uses the window ending there, not today', () => {
    expect(trainingProgress(w, logs, '2026-11-20', 1, '2026-10-14').month.total).toBe(4);
  });
});

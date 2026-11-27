import { describe, it, expect } from 'vitest';
import { gymToday, parseBlockLevelInput, trainingProgress } from '../domain/workoutProgress';

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
    // Calendar month up to today = 10-01..10-14: Mondays 10/5,10/12 + Wednesdays 10/7,10/14 (#3401)
    expect(p.month.total).toBe(4);
    expect(p.month.completed).toBe(2);
    expect(trainingProgress([], [], '2026-10-14').day.percent).toBe(0);
  });
  it('a workout with a block missing is not done, but its logged block counts (#3494)', () => {
    const p = trainingProgress([{ id: 1, weekday: 3, blockIds: [1, 2] }], [{ blockId: 1, date: '2026-10-14' }], '2026-10-14');
    expect(p.day).toEqual({ completed: 0.5, total: 1, percent: 50 });
  });
});

describe('trainingProgress for a selected date (#1370 stage 2)', () => {
  // Mondays (weekday 1) in Oct 2026: 5, 12, 19, 26
  const w = [{ id: 1, weekday: 1, blockIds: [1] }];
  const logs = [{ blockId: 1, date: '2026-10-05' }, { blockId: 1, date: '2026-10-12' }];
  it('uses a rolling 7-day week ending on the selected date (#1524) and its calendar month (#3401)', () => {
    const p = trainingProgress(w, logs, '2026-10-14', 1, '2026-10-05');
    expect(p.day).toEqual({ completed: 1, total: 1, percent: 100 });
    // Last 7 days = 09-29..10-05: only Monday 10/5 (9/28 is out)
    expect(p.week).toEqual({ completed: 1, total: 1, percent: 100 });
    // October up to today (10-14): Mondays 10/5 and 10/12, both done
    expect(p.month).toEqual({ completed: 2, total: 2, percent: 100 });
  });
  it('a future selected day counts its own workouts (#1549), a future week none', () => {
    const p = trainingProgress(w, logs, '2026-10-14', 1, '2026-10-19');
    expect(p.day).toEqual({ completed: 0, total: 1, percent: 0 });
    expect(p.week.total).toBe(0);
    expect(p.month.total).toBe(2); // October capped at today: 10/5, 10/12
  });
  it('the window includes both boundary days (#1524)', () => {
    const wed = [{ id: 1, weekday: 3, blockIds: [1] }];
    // 7 days ending Wed 10-14 start Thu 10-08, so Wed 10-07 is out and 10-14 is in
    expect(trainingProgress(wed, [], '2026-10-14').week.total).toBe(1);
    // October up to 10-14: Wed 10/7 and 10/14; September's are out
    expect(trainingProgress(wed, [], '2026-10-14').month.total).toBe(2);
  });
  it('a past date reports its own whole calendar month, not today\'s (#3401)', () => {
    // All of October: Mondays 5, 12, 19, 26
    expect(trainingProgress(w, logs, '2026-11-20', 1, '2026-10-14').month).toEqual({ completed: 2, total: 4, percent: 50 });
  });
  it('a month across a year boundary is its own calendar month (#3401)', () => {
    // Mondays of December 2025: 1, 8, 15, 22, 29
    expect(trainingProgress(w, [], '2026-01-03', 1, '2025-12-15').month.total).toBe(5);
  });
  it('a month that has not started yet reads 0 %', () => {
    expect(trainingProgress(w, [], '2026-10-14', 1, '2026-11-02').month).toEqual({ completed: 0, total: 0, percent: 0 });
  });
});

describe('partial completion and unscheduled workouts (#3494)', () => {
  // 2026-10-14 is a Wednesday (weekday 3)
  const w = [{ id: 1, weekday: 3, blockIds: [1, 2] }];
  it('a workout contributes the mean of its blocks: Fully Done 1, Partially Done 0.5', () => {
    expect(trainingProgress(w, [{ blockId: 1, date: '2026-10-14' }], '2026-10-14').day)
      .toEqual({ completed: 0.5, total: 1, percent: 50 });
    expect(trainingProgress(w, [{ blockId: 1, date: '2026-10-14', level: 'partial' }], '2026-10-14').day)
      .toEqual({ completed: 0.25, total: 1, percent: 25 });
  });
  it('a block logged twice counts its highest level once', () => {
    const logs = [
      { blockId: 1, date: '2026-10-14', level: 'partial' }, { blockId: 1, date: '2026-10-14', level: 'done' },
      { blockId: 1, date: '2026-10-14', level: 'done' }, { blockId: 2, date: '2026-10-14', level: 'done' },
    ];
    expect(trainingProgress(w, logs, '2026-10-14').day).toEqual({ completed: 1, total: 1, percent: 100 });
  });
  it('a workout with no weekday is counted every day, inside its plan dates', () => {
    const any = [{ id: 2, weekday: null, blockIds: [5], startDate: '2026-10-13', endDate: null }];
    const p = trainingProgress(any, [{ blockId: 5, date: '2026-10-14' }], '2026-10-14');
    expect(p.day).toEqual({ completed: 1, total: 1, percent: 100 });
    expect(p.week).toEqual({ completed: 1, total: 2, percent: 50 }); // 10-13 and 10-14 only
  });
  it('parses the level: absent is done, anything else is refused', () => {
    expect(parseBlockLevelInput(undefined)).toBe('done');
    expect(parseBlockLevelInput('partial')).toBe('partial');
    expect(parseBlockLevelInput('half')).toMatch(/level must be/);
  });
});

// #1580: the rules of My Nutrition's progress, asserted from the requirement —
// future meals are not in a denominator, a day is complete only when every
// eligible meal is, and an empty period reads 0 % rather than dividing by zero.
import { describe, expect, it } from 'vitest';
import { canCompleteOn, isMealScheduledOn, mondayWeek, nutritionProgress } from '../domain/nutritionProgress';

// 2026-10-14 is a Wednesday: weekday 2 in the nutrition plan's Monday-based numbering.
const TODAY = '2026-10-14';

describe('nutritionProgress', () => {
  it('excludes future meals from the denominator', () => {
    const meals = [{ id: 1, weekday: 7 }];
    const p = nutritionProgress(meals, [{ mealId: 1, date: TODAY }], TODAY, TODAY);
    expect(p.day).toEqual({ completed: 1, total: 1, percent: 100 });
    // Window ends today: Thursday..Sunday of this week are not counted.
    expect(p.week.total).toBe(7);
  });

  it('reads 0 % when nothing is scheduled', () => {
    const p = nutritionProgress([], [], TODAY);
    expect(p.day).toEqual({ completed: 0, total: 0, percent: 0 });
    expect(p.week_days.every((d) => d.status === 'rest')).toBe(true);
  });

  it('colours the week: completed, pending, scheduled, rest', () => {
    const meals = [{ id: 1, weekday: 0 }, { id: 2, weekday: 2 }, { id: 3, weekday: 4 }]; // Mon, Wed, Fri
    const p = nutritionProgress(meals, [{ mealId: 1, date: '2026-10-12' }], TODAY);
    const by = Object.fromEntries(p.week_days.map((d) => [d.date, d.status]));
    expect(by['2026-10-12']).toBe('completed');
    expect(by['2026-10-13']).toBe('rest');
    expect(by['2026-10-14']).toBe('pending');
    expect(by['2026-10-16']).toBe('scheduled');
  });

  it('a partly completed day is never completed', () => {
    const meals = [{ id: 1, weekday: 2 }, { id: 2, weekday: 2 }];
    const p = nutritionProgress(meals, [{ mealId: 1, date: TODAY }], TODAY);
    expect(p.week_days.find((d) => d.date === TODAY)!.status).toBe('pending');
    expect(p.day.percent).toBe(50);
  });
});

describe('helpers', () => {
  it('only today and the past can be completed', () => {
    expect(canCompleteOn(TODAY, TODAY)).toBe(true);
    expect(canCompleteOn('2026-10-13', TODAY)).toBe(true);
    expect(canCompleteOn('2026-10-15', TODAY)).toBe(false);
  });
  it('an all-days meal is scheduled every day, a weekday meal only on its day', () => {
    expect(isMealScheduledOn({ id: 1, weekday: 7 }, TODAY)).toBe(true);
    expect(isMealScheduledOn({ id: 1, weekday: 2 }, TODAY)).toBe(true);
    expect(isMealScheduledOn({ id: 1, weekday: 3 }, TODAY)).toBe(false);
  });
  it('the week is Monday first', () => {
    const w = mondayWeek(TODAY);
    expect(w[0]).toBe('2026-10-12');
    expect(w[6]).toBe('2026-10-18');
  });
});

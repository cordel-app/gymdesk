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

// #1603 — weighted daily score: restrictions 30 %, goals 30 %, meals 40 %.
describe('nutritionProgress weighted score (#1603)', () => {
  const none = { goalIds: [], restrictionIds: [] };
  const statusOn = (p: ReturnType<typeof nutritionProgress>, d: string) => p.week_days.find((x) => x.date === d)!;

  it('partially done restrictions earn half of their 30 % share', () => {
    const meals = [{ id: 1, weekday: 7 }];
    const req = { goalIds: [10], restrictionIds: [20] };
    const logs = [
      { mealId: 1, date: TODAY },
    ];
    const reqLogs = [
      { kind: 'restriction' as const, itemId: 20, date: TODAY, level: 'partial' as const },
      { kind: 'goal' as const, itemId: 10, date: TODAY, level: 'done' as const },
    ];
    const p = nutritionProgress(meals, logs, TODAY, TODAY, req, reqLogs);
    // 40 (meals) + 30 (goal) + 15 (half of restrictions) = 85
    expect(p.day.percent).toBe(85);
    expect(statusOn(p, TODAY).score).toBe(85);
    const full = nutritionProgress(meals, logs, TODAY, TODAY, req, [{ ...reqLogs[0], level: 'done' as const }, reqLogs[1]]);
    expect(full.day.percent).toBe(100);
    expect(statusOn(full, TODAY).status).toBe('completed');
  });

  it('a day with only goals and restrictions is never grey, even with no meals', () => {
    const req = { goalIds: [10], restrictionIds: [20] };
    const p = nutritionProgress([], [], TODAY, TODAY, req, []);
    expect(statusOn(p, TODAY).status).toBe('pending');
    expect(statusOn(p, '2026-10-16').status).toBe('scheduled'); // future, not grey
    const done = nutritionProgress([], [], TODAY, TODAY, req, [
      { kind: 'goal', itemId: 10, date: TODAY, level: 'done' },
      { kind: 'restriction', itemId: 20, date: TODAY, level: 'done' },
    ]);
    expect(statusOn(done, TODAY).status).toBe('completed');
  });

  it('grey only when nothing applies', () => {
    expect(statusOn(nutritionProgress([], [], TODAY, TODAY, none, []), TODAY).status).toBe('rest');
  });

  it('closed days: <=50 red (pending), >50 and <100 half (partial), 100 green', () => {
    const req = { goalIds: [], restrictionIds: [20] };
    const y = '2026-10-13'; // before TODAY
    const p = (level?: 'partial' | 'done') => statusOn(
      nutritionProgress([], [], TODAY, TODAY, req, level ? [{ kind: 'restriction', itemId: 20, date: y, level }] : []), y);
    expect(p().status).toBe('pending');          // 0 %
    expect(p('partial').status).toBe('pending'); // exactly 50 % is still red
    expect(p('done').status).toBe('completed');
    // meals 1 of 2 (20 of 40) + restriction partial (15 of 30) = 35/70 = 50 %; +1 meal => 85/... half
    const meals = [{ id: 1, weekday: 7 }, { id: 2, weekday: 7 }, { id: 3, weekday: 7 }];
    const half = nutritionProgress(meals, [{ mealId: 1, date: y }, { mealId: 2, date: y }], TODAY, TODAY, req,
      [{ kind: 'restriction', itemId: 20, date: y, level: 'partial' }]);
    expect(statusOn(half, y).status).toBe('partial'); // 26.7 + 15 = 41.7 of 70 = 60 %
  });
});

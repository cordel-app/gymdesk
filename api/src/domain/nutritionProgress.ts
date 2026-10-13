// #1580 — what "done" means for My Nutrition and how its progress is counted.
// Pure: no DB, no HTTP. Dates are `YYYY-MM-DD` in the gym's time zone (#1246);
// weekday is the nutrition plan's own numbering — 0=Monday … 6=Sunday, NOT the
// training/calendar 0=Sunday base (migration 105, member-nutrition-plans.ts) —
// and 7 means "every day". A scheduled meal instance is (meal id, date); it is eligible for
// completion when its date is today or earlier. Windows follow My Training's
// (#1524): rolling 7 and 30 days ending on the selected date, never past today,
// and a period with nothing eligible reads 0 %.
import { DateTime } from 'luxon';
import { ROLLING_MONTH_DAYS, ROLLING_WEEK_DAYS } from './workoutProgress';

export const ALL_DAYS_WEEKDAY = 7;

export interface PlanMeal { id: number; weekday: number }
export interface MealCompletion { mealId: number; date: string }
export interface ProgressCounts { completed: number; total: number; percent: number }
export type NutritionDayStatus = 'completed' | 'pending' | 'scheduled' | 'rest';
export interface NutritionProgress {
  day: ProgressCounts; week: ProgressCounts; month: ProgressCounts;
  week_days: { date: string; status: NutritionDayStatus }[];
}

function counts(completed: number, total: number): ProgressCounts {
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

/** 0=Monday … 6=Sunday, the nutrition plan day numbering. */
export function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday - 1;
}

/** A meal is scheduled on a date when its day is that weekday or "all days". */
export function isMealScheduledOn(meal: PlanMeal, date: string): boolean {
  return meal.weekday === ALL_DAYS_WEEKDAY || meal.weekday === weekdayOf(date);
}

/** Only today and the past can be marked done. */
export function canCompleteOn(date: string, today: string): boolean {
  return date <= today;
}

/** The seven dates of the Monday-first week containing `date`. */
export function mondayWeek(date: string): string[] {
  const d = DateTime.fromISO(date, { zone: 'UTC' });
  const start = d.minus({ days: d.weekday - 1 });
  return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toISODate() as string);
}

export function nutritionProgress(
  meals: PlanMeal[],
  completions: MealCompletion[],
  today: string,
  selected: string = today,
): NutritionProgress {
  const done = new Set(completions.map((c) => `${c.mealId}|${String(c.date).slice(0, 10)}`));
  const isDone = (m: PlanMeal, date: string) => done.has(`${m.id}|${date}`);
  const range = (from: string, to: string): ProgressCounts => {
    let c = 0, t = 0;
    for (let d = DateTime.fromISO(from, { zone: 'UTC' }); (d.toISODate() as string) <= to; d = d.plus({ days: 1 })) {
      const date = d.toISODate() as string;
      for (const m of meals) {
        if (!isMealScheduledOn(m, date)) continue;
        t++;
        if (isDone(m, date)) c++;
      }
    }
    return counts(c, t);
  };
  const sel = DateTime.fromISO(selected, { zone: 'UTC' });
  const end = selected > today ? today : selected;
  const dayStatus = (date: string): NutritionDayStatus => {
    const scheduled = meals.filter((m) => isMealScheduledOn(m, date));
    if (scheduled.length === 0) return 'rest';
    if (scheduled.every((m) => isDone(m, date))) return 'completed';
    return canCompleteOn(date, today) ? 'pending' : 'scheduled';
  };
  return {
    day: selected > today ? counts(0, 0) : range(selected, selected),
    week: range(sel.minus({ days: ROLLING_WEEK_DAYS - 1 }).toISODate() as string, end),
    month: range(sel.minus({ days: ROLLING_MONTH_DAYS - 1 }).toISODate() as string, end),
    week_days: mondayWeek(selected).map((date) => ({ date, status: dayStatus(date) })),
  };
}

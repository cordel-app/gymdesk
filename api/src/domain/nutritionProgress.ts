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
export type NutritionDayStatus = 'completed' | 'partial' | 'pending' | 'scheduled' | 'rest';
export type RequirementKind = 'goal' | 'restriction';
export type RequirementLevel = 'partial' | 'done';
/** The plan's goals and dietary restrictions; both apply on every day (applies_all_days). */
export interface PlanRequirements { goalIds: number[]; restrictionIds: number[] }
export interface RequirementCompletion { kind: RequirementKind; itemId: number; date: string; level: RequirementLevel }

// #1603 — the daily score is weighted: restrictions 30 %, goals 30 %, meals 40 %.
// A category that does not apply that day drops out and the rest are re-based,
// so a day with only goals is scored on goals alone.
export const WEIGHT_RESTRICTIONS = 30;
export const WEIGHT_GOALS = 30;
export const WEIGHT_MEALS = 40;
/** A restriction marked "partially done" earns half of its share. */
export const PARTIAL_CREDIT = 0.5;
export interface NutritionProgress {
  day: ProgressCounts; week: ProgressCounts; month: ProgressCounts;
  week_days: { date: string; status: NutritionDayStatus; score: number | null }[];
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
  requirements: PlanRequirements = { goalIds: [], restrictionIds: [] },
  requirementLogs: RequirementCompletion[] = [],
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
  const reqLevel = new Map(requirementLogs.map((l) => [`${l.kind}|${l.itemId}|${String(l.date).slice(0, 10)}`, l.level]));
  /** Weighted 0..100 score of a date, or null when nothing at all applies to it. */
  const dayScore = (date: string): number | null => {
    const scheduled = meals.filter((m) => isMealScheduledOn(m, date));
    let earned = 0, possible = 0;
    if (scheduled.length > 0) {
      possible += WEIGHT_MEALS;
      earned += WEIGHT_MEALS * (scheduled.filter((m) => isDone(m, date)).length / scheduled.length);
    }
    if (requirements.goalIds.length > 0) {
      possible += WEIGHT_GOALS;
      const done = requirements.goalIds.filter((id) => reqLevel.get(`goal|${id}|${date}`) === 'done').length;
      earned += WEIGHT_GOALS * (done / requirements.goalIds.length);
    }
    if (requirements.restrictionIds.length > 0) {
      possible += WEIGHT_RESTRICTIONS;
      const credit = requirements.restrictionIds.reduce((sum, id) => {
        const level = reqLevel.get(`restriction|${id}|${date}`);
        return sum + (level === 'done' ? 1 : level === 'partial' ? PARTIAL_CREDIT : 0);
      }, 0);
      earned += WEIGHT_RESTRICTIONS * (credit / requirements.restrictionIds.length);
    }
    return possible === 0 ? null : Math.round((earned / possible) * 100);
  };
  // Grey only when nothing applies. A closed day (before today) is judged by its
  // score — red up to 50 %, half-and-half above it, green at 100 %; today stays
  // open (red until complete) and a later day is "scheduled".
  const dayStatus = (date: string): NutritionDayStatus => {
    const score = dayScore(date);
    if (score === null) return 'rest';
    if (score === 100) return 'completed';
    if (date > today) return 'scheduled';
    if (date === today) return 'pending';
    return score > 50 ? 'partial' : 'pending';
  };
  return {
    day: selected > today ? counts(0, 0) : { ...range(selected, selected), percent: dayScore(selected) ?? 0 },
    week: range(sel.minus({ days: ROLLING_WEEK_DAYS - 1 }).toISODate() as string, end),
    month: range(sel.minus({ days: ROLLING_MONTH_DAYS - 1 }).toISODate() as string, end),
    week_days: mondayWeek(selected).map((date) => ({ date, status: dayStatus(date), score: date > today ? null : dayScore(date) })),
  };
}

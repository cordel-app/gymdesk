// #3545 — the combined completion of today's meals on Home's "Today's Nutrition Plan"
// card. Pure: no React, no `t()`, no network. It restates no rule: a meal's completion
// is its `nutrition_logs` row for the date (Fully Done `done`, Partially Done `partial`,
// a log with no level a full completion — #3489), exactly what My Nutrition reads, and
// this only combines today's meals into one of three states. Nothing is scored here,
// so the nutrition progress calculation is untouched.
import type { StatusTone } from './memberChrome';

export type MealsStatus = 'not_started' | 'partial' | 'done';

export interface MealLog { meal_id: number; logged_date: string; level?: 'partial' | 'done' | null }

/** Not Started: no meal logged; Fully Done: every meal fully done; otherwise Partially Done. */
export function mealsCompletionStatus(mealIds: number[], logs: MealLog[], date: string): MealsStatus {
  const levels = new Map<number, 'partial' | 'done'>();
  for (const l of logs) {
    if (String(l.logged_date).slice(0, 10) !== date) continue;
    const level = l.level === 'partial' ? 'partial' : 'done';
    if (levels.get(l.meal_id) !== 'done') levels.set(l.meal_id, level);
  }
  const ids = [...new Set(mealIds)];
  const logged = ids.filter((id) => levels.has(id));
  if (logged.length === 0) return 'not_started';
  return ids.every((id) => levels.get(id) === 'done') ? 'done' : 'partial';
}

/** The locale key under `nutrition` the chip reads. */
export function mealsStatusKey(status: MealsStatus): string {
  return status === 'done' ? 'fully_done' : status === 'partial' ? 'partially_done' : 'not_started';
}

/** The existing status tone each state takes. */
export function mealsStatusTone(status: MealsStatus): StatusTone {
  return status === 'done' ? 'success' : status === 'partial' ? 'warning' : 'neutral';
}

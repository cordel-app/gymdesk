// #3489 — the fill of a day's circle in My Nutrition's week card. Pure: no React, no `t()`.
// The API reports each day's weighted completion score (`week_days[].score`, 0..100, null
// for a day nothing applies to or a future one); this only turns it into a background. The
// green share of the circle is the score, drawn as a pie from 12 o'clock clockwise, and the
// rest of the circle is red — so 50 % is exactly half green, 75 % three quarters, 0 % none.
// A day with no score keeps its status colour (grey rest, yellow scheduled).
import type { NutritionDayStatus } from './trainingDayStatus';

export interface DayIndicatorColors { success: string; error: string; status: Record<NutritionDayStatus, string> }

/** The score clamped to 0..100, or null when it is not a number. */
export function indicatorPercent(score: number | null | undefined): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return Math.min(100, Math.max(0, score));
}

export function dayIndicatorBackground(status: NutritionDayStatus, score: number | null | undefined, colors: DayIndicatorColors): string {
  const pct = indicatorPercent(score);
  if (pct === null || status === 'rest' || status === 'scheduled') return colors.status[status];
  if (pct >= 100) return colors.success;
  if (pct <= 0) return colors.error;
  return `conic-gradient(${colors.success} 0% ${pct}%, ${colors.error} ${pct}% 100%)`;
}

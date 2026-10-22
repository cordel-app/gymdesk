/**
 * #1957 — which assigned Nutrition Plan applies on a date.
 *
 * Both bounds are inclusive; a NULL `end_date` is an ongoing assignment and a NULL `start_date` has already started. The one
 * SQL fragment every reader of "the member's plan on day D" shares, so the Members
 * App cannot show a plan before it starts or after it was completed.
 */

export const NUTRITION_PLAN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses the optional `?date=` of a read; `undefined` means today, `null` is invalid. */
export function parseNutritionPlanDate(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !NUTRITION_PLAN_DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

/**
 * Predicate over `member_nutrition_plans` aliased `alias`, binding one date (twice).
 * Today's plan is the `active` one; a past date may also be a `completed` one.
 */
export function planEffectiveOnSql(alias = 'mnp'): string {
  return `(${alias}.status IN ('active', 'completed')
    AND (${alias}.start_date IS NULL OR ${alias}.start_date <= ?)
    AND (${alias}.end_date IS NULL OR ${alias}.end_date >= ?)
    AND (${alias}.status = 'active' OR ${alias}.end_date IS NOT NULL))`;
}

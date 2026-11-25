import { DateTime } from 'luxon';

/**
 * #1970: versioning of assigned Nutrition Plans. Pure — the I/O half is the
 * `edit-draft` / `publish-version` routes in api/src/api/member-nutrition-plans.ts.
 *
 * A version's name is `<base name> [<start> - <end>]`, with the literal `Open End`
 * while it has no end date. The base name is derived by stripping that suffix, so
 * editing a plan more than once never accumulates suffixes.
 */

export const OPEN_END_LABEL = 'Open End';

const VERSION_SUFFIX_RE = /\s*\[\d{4}-\d{2}-\d{2} - (?:\d{4}-\d{2}-\d{2}|Open End)\]\s*$/;

export function baseNutritionPlanName(name: string): string {
  return name.replace(VERSION_SUFFIX_RE, '').trim();
}

export function versionedNutritionPlanName(name: string, start: string, end: string | null): string {
  return `${baseNutritionPlanName(name)} [${start} - ${end ?? OPEN_END_LABEL}]`;
}

/** The day after a YYYY-MM-DD date, in the same format. */
export function nextDay(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: 1 }).toISODate() as string;
}

/**
 * #3405: how an assigned Nutrition Plan is edited, decided in one place.
 *
 * - `in_place`: the plan itself is edited. A Draft (a version not yet published), and an
 *   Active plan that has not been effective before today — its start date is today or later,
 *   so no member has been shown it on an earlier date and nothing historical can move.
 * - `versioned`: an Active plan effective before today is an immutable snapshot; Edit opens
 *   (or resumes) a Draft copy and only `publish-version` replaces it.
 * - `read_only`: completed, cancelled or deleted — never edited.
 *
 * `today` is the gym's own date (YYYY-MM-DD); a plan with no start date is treated as
 * started long ago, since it has been effective on every date.
 */
export type NutritionPlanEditMode = 'in_place' | 'versioned' | 'read_only';

export function nutritionPlanEditMode(
  plan: { status: string; start_date: string | Date | null },
  today: string,
): NutritionPlanEditMode {
  if (plan.status === 'draft') return 'in_place';
  if (plan.status !== 'active') return 'read_only';
  const start = plan.start_date == null
    ? null
    : typeof plan.start_date === 'string' ? plan.start_date.slice(0, 10) : plan.start_date.toISOString().slice(0, 10);
  return start !== null && start >= today ? 'in_place' : 'versioned';
}

/**
 * #1360: mirror of `EXERCISE_CATEGORIES` (`api/src/domain/exerciseCategories.ts`),
 * which is the authority — the API judges every write. A new category goes in
 * both, plus an `exercises.category_<value>` label (spaces as underscores) in
 * en/es/ca.
 */
export const EXERCISE_CATEGORIES = [
  'cardio',
  'olympic weightlifting',
  'plyometrics',
  'powerlifting',
  'strength',
  'stretching',
  'strongman',
] as const;

export function isExerciseCategory(value: string | null | undefined): boolean {
  return !!value && (EXERCISE_CATEGORIES as readonly string[]).includes(value.trim().toLowerCase());
}

/** The locale key suffix for a supported category, or `null` (decided before `t()` is called). */
export function exerciseCategoryLabelKey(value: string | null | undefined): string | null {
  if (!value || !isExerciseCategory(value)) return null;
  return `category_${value.trim().toLowerCase().replace(/\s+/g, '_')}`;
}

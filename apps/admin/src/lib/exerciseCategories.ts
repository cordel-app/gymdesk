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

/**
 * #1360 stage 2: mirror of `CATEGORY_RESULT_TYPE_SLUGS`
 * (`api/src/domain/exerciseCategories.ts`) — display only. The API derives and
 * persists the real set; this decides which chips the editor shows before the
 * category is saved.
 */
export const CATEGORY_RESULT_TYPE_SLUGS: Record<string, readonly string[]> = {
  cardio: ['distance', 'duration', 'pace', 'speed', 'calories'],
  'olympic weightlifting': ['repetitions', 'weight'],
  plyometrics: ['repetitions'],
  powerlifting: ['repetitions', 'weight'],
  strength: ['repetitions', 'weight'],
  stretching: ['duration'],
  strongman: ['repetitions', 'weight', 'distance', 'duration'],
};

/** Recorded Metrics slugs for a category, or `null` when it is missing/unsupported (no guess). */
export function recordedMetricSlugs(category: string | null | undefined): readonly string[] | null {
  if (!category || !isExerciseCategory(category)) return null;
  return CATEGORY_RESULT_TYPE_SLUGS[category.trim().toLowerCase()] ?? null;
}

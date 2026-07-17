/**
 * #62: muscles are a fixed catalog, not per-gym DB rows. Keys are stable
 * slugs stored on exercise_muscles.muscle; display names are an admin-app
 * i18n concern. Legacy keys migrated from the old muscles table may fall
 * outside this list — they stay valid on existing links but are not offered
 * for new selections.
 */
export const MUSCLE_KEYS = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps',
  'quads', 'hamstrings', 'glutes', 'calves', 'core',
] as const;

export type MuscleKey = (typeof MUSCLE_KEYS)[number];

const MUSCLE_KEY_PATTERN = /^[a-z0-9_]{1,60}$/;

/** Normalizes arbitrary input to a storable muscle key, or null if invalid. */
export function normalizeMuscleKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return MUSCLE_KEY_PATTERN.test(key) ? key : null;
}

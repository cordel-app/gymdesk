/**
 * #1360 stage 1: the closed set of Exercise categories and the one place a
 * category value is normalized and judged.
 *
 * `exercises.category` was free text preserved verbatim from the Free Exercise
 * DB (#964). Recorded Metrics are derived from it (stage 2), so the value must
 * be one of seven, stored **lowercase and trimmed**: matching is then a plain
 * string comparison and `Cardio` / `CARDIO` can never be two categories.
 *
 * Adding a category goes in **two** places: this list and a
 * `exercises.category_<value>` label (spaces as underscores) in
 * `apps/admin/locales/base/{en,es,ca}.json`, plus the admin mirror
 * (`apps/admin/src/lib/exerciseCategories.ts`).
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

export type ExerciseCategory = (typeof EXERCISE_CATEGORIES)[number];

/**
 * Category → result-type slugs (the existing `result_types` catalogue, #154).
 * Declared with the categories so stage 2 derives
 * `exercise_allowed_result_types` from this table and nothing else.
 */
export const CATEGORY_RESULT_TYPE_SLUGS: Record<ExerciseCategory, readonly string[]> = {
  cardio: ['distance', 'duration', 'pace', 'speed', 'calories'],
  'olympic weightlifting': ['repetitions', 'weight'],
  plyometrics: ['repetitions'],
  powerlifting: ['repetitions', 'weight'],
  strength: ['repetitions', 'weight'],
  stretching: ['duration'],
  strongman: ['repetitions', 'weight', 'distance', 'duration'],
};

/** Trim and lowercase; `null` for absent or blank. Never maps one category onto another. */
export function normalizeExerciseCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

export function isExerciseCategory(value: unknown): value is ExerciseCategory {
  const normalized = normalizeExerciseCategory(value);
  return normalized !== null && (EXERCISE_CATEGORIES as readonly string[]).includes(normalized);
}

/** Result-type slugs for a category, or `null` when it is missing or unsupported (no guess). */
export function resultTypeSlugsForCategory(value: unknown): readonly string[] | null {
  const normalized = normalizeExerciseCategory(value);
  return normalized !== null && isExerciseCategory(normalized) ? CATEGORY_RESULT_TYPE_SLUGS[normalized] : null;
}

export interface ExerciseCategoryInput {
  /** Whether the request mentioned `category` at all (absent keeps the stored value). */
  provided: boolean;
  /** The normalized category to store; `null` clears it. */
  value: ExerciseCategory | null;
  error?: string;
}

/**
 * The only place a request's `category` is judged: absent keeps what is stored,
 * `null`/`''` clears it, a supported value (any casing) is stored normalized,
 * anything else is a 400 — never coerced onto a supported category.
 */
export function parseExerciseCategoryInput(body: Record<string, unknown> | undefined): ExerciseCategoryInput {
  if (!body || !('category' in body)) return { provided: false, value: null };
  const raw = body.category;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { provided: true, value: null };
  if (typeof raw !== 'string' || !isExerciseCategory(raw)) {
    return {
      provided: true,
      value: null,
      error: `category must be one of: ${EXERCISE_CATEGORIES.join(', ')}`,
    };
  }
  return { provided: true, value: normalizeExerciseCategory(raw) as ExerciseCategory };
}

/** The four cases of the #1360 audit, in the order the ticket lists them. */
export type CategoryAuditIssue =
  | 'valid'
  | 'valid_after_normalization'
  | 'spelling_variant'
  | 'missing'
  | 'unsupported';

/**
 * Classifies a stored category without ever repairing it: the audit reports,
 * a human decides. A spelling variant differs from a supported value only in
 * separators or punctuation (`olympic-weightlifting`, `Olympic_Weightlifting`).
 */
export function classifyStoredCategory(stored: string | null | undefined): { issue: CategoryAuditIssue; suggestion: ExerciseCategory | null } {
  if (stored === null || stored === undefined) return { issue: 'missing', suggestion: null };
  if ((EXERCISE_CATEGORIES as readonly string[]).includes(stored)) return { issue: 'valid', suggestion: null };
  const normalized = normalizeExerciseCategory(stored);
  if (normalized === null) return { issue: 'missing', suggestion: null };
  if (isExerciseCategory(normalized)) return { issue: 'valid_after_normalization', suggestion: normalized };
  const squashed = normalized.replace(/[^a-z0-9]+/g, ' ').trim();
  if (isExerciseCategory(squashed)) return { issue: 'spelling_variant', suggestion: squashed as ExerciseCategory };
  return { issue: 'unsupported', suggestion: null };
}

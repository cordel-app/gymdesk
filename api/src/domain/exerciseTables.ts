/**
 * #1849 stage E2 (Exercises) — which tables an exercise helper reads or writes, the
 * `FoodTables` (domain/nutritionLibrary.ts) of this catalogue.
 *
 * - `LEGACY_EXERCISE_TABLES`: the gym-owned rows (and, until the final stage, the
 *   mirrored System rows the plan tables still reference).
 * - `BASE_EXERCISE_TABLES`: the platform's Exercises (`base_exercises`, migration 336),
 *   which Cordel's router writes.
 * - `CATALOGUE_EXERCISE_TABLES`: the read models (migration 338) a gym-facing reader
 *   joins: Base rows (`gym_id` NULL) plus the gym-owned legacy rows.
 */
export interface ExerciseTables {
  exercises: string;
  translations: string;
  descriptions: string;
  muscles: string;
  resultTypes: string;
  /** Whether the muscle junction carries a `gym_id` column (the legacy one does). */
  musclesHaveGymId: boolean;
}

export const LEGACY_EXERCISE_TABLES: ExerciseTables = {
  exercises: 'exercises',
  translations: 'exercise_translations',
  descriptions: 'exercise_description_translations',
  muscles: 'exercise_muscles',
  resultTypes: 'exercise_allowed_result_types',
  musclesHaveGymId: true,
};

export const BASE_EXERCISE_TABLES: ExerciseTables = {
  exercises: 'base_exercises',
  translations: 'base_exercise_translations',
  descriptions: 'base_exercise_description_translations',
  muscles: 'base_exercise_muscles',
  resultTypes: 'base_exercise_allowed_result_types',
  musclesHaveGymId: false,
};

export const CATALOGUE_EXERCISE_TABLES: ExerciseTables = {
  exercises: 'exercise_catalogue',
  translations: 'exercise_translation_catalogue',
  descriptions: 'exercise_description_translation_catalogue',
  muscles: 'exercise_muscle_catalogue',
  resultTypes: 'exercise_allowed_result_type_catalogue',
  musclesHaveGymId: false,
};

/**
 * #3339: what the *Confirm Workout Template Import* step of the Import System
 * Workout Templates modal shows. The API's `POST /workout-templates/import/preview`
 * (`planWorkoutTemplateImport()`) decides everything — which templates are
 * created and which Base Exercises the gym is missing, each once across the
 * selection — and `POST /import` executes that same plan. This module only
 * shapes that answer (locale keys, no `t()`), so nothing about the cascade is
 * re-decided in the browser.
 */

export interface WorkoutImportPreview {
  workout_templates: { id: number; name: string; action: 'create' | 'existing'; gym_template_id: number | null }[];
  exercises: { id: number; name: string }[];
}

export interface WorkoutImportResult {
  imported: unknown[];
  skipped: unknown[];
  exercises?: { imported: unknown[] };
}

/**
 * Whether the confirmation step is shown at all: only when the import would
 * bring Exercises along. With none missing, the import runs straight away
 * rather than showing an empty list.
 */
export function needsCascadeConfirmation(preview: WorkoutImportPreview): boolean {
  return preview.exercises.length > 0;
}

/** The Exercises the confirmation lists, in the API's own order (already de-duplicated there). */
export function cascadeExercises(preview: WorkoutImportPreview): { id: number; name: string }[] {
  return preview.exercises.map((e) => ({ id: e.id, name: e.name }));
}

/**
 * The toast after an import: the templates imported, those skipped, then the
 * Exercises it imported (each part only when non-zero, the first always).
 * Answers `[key, n]` pairs for the page to resolve in `workout_templates`.
 */
export function cascadeResultParts(result: WorkoutImportResult): [string, number][] {
  const parts: [string, number][] = [['imported', result.imported.length]];
  if (result.skipped.length > 0) parts.push(['imported_skipped', result.skipped.length]);
  const exercises = result.exercises?.imported.length ?? 0;
  if (exercises > 0) parts.push(['cascade_result_exercises_imported', exercises]);
  return parts;
}

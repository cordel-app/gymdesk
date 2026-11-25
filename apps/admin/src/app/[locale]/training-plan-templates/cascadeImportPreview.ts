/**
 * #3337 stage 2: what the *Confirm Cascading Import* step of the Import System
 * Training Plan Templates modal shows. The API's `POST
 * /training-plan-templates/import/preview` (`planCascadingImport()`) decides
 * everything — which Workout Templates are created or updated and which Base
 * Exercises the gym is missing, each once across the selection — and `POST
 * /import` executes that same plan. This module only shapes that answer for the
 * modal (locale keys, no `t()`), so nothing about the cascade is re-decided in
 * the browser.
 */

export interface CascadePreview {
  training_plan_templates: { id: number; name: string; action: 'create' | 'existing'; gym_template_id: number | null }[];
  workout_templates: { id: number; name: string; action: 'create' | 'update'; gym_template_id: number | null }[];
  exercises: { id: number; name: string }[];
}

export interface CascadeImportResult {
  imported: unknown[];
  skipped: unknown[];
  workout_templates?: { created: unknown[]; updated: unknown[] };
  exercises?: { imported: unknown[] };
}

export interface CascadeWorkoutRow {
  id: number;
  name: string;
  /** Locale key in `training_plan_templates` for the row's operation. */
  actionKey: 'cascade_action_create' | 'cascade_action_update';
}

export interface CascadeSections {
  workoutTemplates: CascadeWorkoutRow[];
  exercises: { id: number; name: string }[];
}

/** The two lists the confirmation shows, in the API's own order (already de-duplicated there). */
export function cascadeSections(preview: CascadePreview): CascadeSections {
  return {
    workoutTemplates: preview.workout_templates.map((w) => ({
      id: w.id,
      name: w.name,
      actionKey: w.action === 'update' ? 'cascade_action_update' : 'cascade_action_create',
    })),
    exercises: preview.exercises.map((e) => ({ id: e.id, name: e.name })),
  };
}

/**
 * The toast after a cascading import: the templates imported, then the
 * dependencies it created, updated or imported (each part only when non-zero).
 * Answers `[key, n]` pairs for the page to resolve.
 */
export function cascadeResultParts(result: CascadeImportResult): [string, number][] {
  const parts: [string, number][] = [['imported', result.imported.length]];
  if (result.skipped.length > 0) parts.push(['imported_skipped', result.skipped.length]);
  const created = result.workout_templates?.created.length ?? 0;
  const updated = result.workout_templates?.updated.length ?? 0;
  const exercises = result.exercises?.imported.length ?? 0;
  if (created > 0) parts.push(['cascade_result_workouts_created', created]);
  if (updated > 0) parts.push(['cascade_result_workouts_updated', updated]);
  if (exercises > 0) parts.push(['cascade_result_exercises_imported', exercises]);
  return parts;
}

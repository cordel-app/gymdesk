import { isBlockFieldVisible } from './blockFieldConfig';

/* Block/exercise shapes shared by the Workout Template tree (#63) and the
 * Training Plan Template tree (#61) — both are fed by JSON_ARRAYAGG hierarchy
 * queries that emit these exact keys. */
export interface HierExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  exercise_type: 'reps' | 'time' | 'distance';
  min_reps: number | null; max_reps: number | null; sets: number | null;
  rest_seconds: number | null; tempo: string | null;
  duration_seconds: number | null;
  distance_value: number | null; distance_unit: string | null;
}
export interface HierBlock {
  id: number; position: number; name: string | null; description: string | null;
  type: string; result_type: string; rounds: number | null; duration_seconds: number | null;
  work_seconds: number | null; rest_seconds: number | null; is_optional: number | boolean;
  notes: string | null; exercises: HierExercise[] | null;
}

export type TFn = (key: string, values?: Record<string, any>) => string;

/** Compact block execution summary; only fields relevant to the block type are shown. */
export function blockSummary(b: HierBlock, t: TFn): string {
  const parts: string[] = [t(`workout_template_blocks.type_${b.type.toLowerCase()}`)];
  if (isBlockFieldVisible(b.type, 'result_type') && b.result_type && b.result_type !== 'None') {
    parts.push(t(`workout_template_blocks.result_type_${b.result_type.toLowerCase()}`));
  }
  if (isBlockFieldVisible(b.type, 'rounds') && b.rounds != null) {
    parts.push(t('training_plan_templates.summary_rounds', { n: b.rounds }));
  }
  if (isBlockFieldVisible(b.type, 'duration_seconds') && b.duration_seconds != null) {
    parts.push(t('training_plan_templates.summary_min', { n: Math.round(b.duration_seconds / 60) }));
  }
  if (isBlockFieldVisible(b.type, 'work_seconds') && b.work_seconds != null) {
    parts.push(t('training_plan_templates.summary_work', { n: b.work_seconds }));
  }
  if (isBlockFieldVisible(b.type, 'rest_seconds') && b.rest_seconds != null) {
    parts.push(t('training_plan_templates.summary_rest', { n: b.rest_seconds }));
  }
  return parts.join(' • ');
}

/** Compact exercise execution summary: sets × reps/duration/distance • Rest. */
export function exerciseSummary(ex: HierExercise, t: TFn): string {
  const parts: string[] = [];
  const type = ex.exercise_type ?? 'reps';

  if (type === 'time') {
    if (ex.sets != null && ex.duration_seconds != null) parts.push(`${ex.sets} × ${ex.duration_seconds}s`);
    else if (ex.sets != null) parts.push(t('training_plan_templates.summary_sets', { n: ex.sets }));
    else if (ex.duration_seconds != null) parts.push(`${ex.duration_seconds}s`);
  } else if (type === 'distance') {
    if (ex.distance_value != null) {
      const unit = ex.distance_unit ?? 'km';
      parts.push(`${ex.distance_value} ${unit}`);
    }
  } else {
    // reps
    let reps: string | null = null;
    if (ex.min_reps != null && ex.max_reps != null) {
      reps = ex.min_reps === ex.max_reps ? String(ex.min_reps) : `${ex.min_reps}–${ex.max_reps}`;
    } else if (ex.min_reps != null) {
      reps = String(ex.min_reps);
    } else if (ex.max_reps != null) {
      reps = String(ex.max_reps);
    }
    if (ex.sets != null && reps) parts.push(`${ex.sets} × ${reps}`);
    else if (ex.sets != null) parts.push(t('training_plan_templates.summary_sets', { n: ex.sets }));
    else if (reps) parts.push(reps);
    if (ex.tempo) parts.push(t('training_plan_templates.summary_tempo', { tempo: ex.tempo }));
  }

  if (ex.rest_seconds != null) {
    const mins = ex.rest_seconds / 60;
    const display = Number.isInteger(mins) ? String(mins) : mins.toFixed(1);
    parts.push(t('block_exercises.rest_min', { n: display }));
  }
  return parts.join(' • ');
}

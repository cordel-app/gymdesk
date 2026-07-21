import { isBlockFieldVisible } from './blockFieldConfig';

/* Block/exercise shapes shared by the Workout Template tree (#63) and the
 * Training Plan Template tree (#61) — both are fed by JSON_ARRAYAGG hierarchy
 * queries that emit these exact keys. */
export interface HierExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null;
  rest_seconds: number | null; tempo: string | null;
  result_type_id: number | null; result_type_slug: string | null; result_type_name: string | null;
  target_value: number | null; min_value: number | null; max_value: number | null; unit: string | null;
}
export interface HierBlock {
  id: number; position: number; name: string | null; description: string | null;
  type: string; rounds: number | null; duration_seconds: number | null;
  work_seconds: number | null; rest_seconds: number | null; is_optional: number | boolean;
  notes: string | null; exercises: HierExercise[] | null;
}

export type TFn = (key: string, values?: Record<string, any>) => string;

/** Compact block execution summary; only fields relevant to the block type are shown. */
export function blockSummary(b: HierBlock, t: TFn): string {
  const parts: string[] = [t(`workout_template_blocks.type_${b.type.toLowerCase()}`)];
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
  const slug = ex.result_type_slug;

  if (slug === 'duration') {
    if (ex.sets != null && ex.target_value != null) parts.push(`${ex.sets} × ${ex.target_value}s`);
    else if (ex.sets != null) parts.push(t('training_plan_templates.summary_sets', { n: ex.sets }));
    else if (ex.target_value != null) parts.push(`${ex.target_value}s`);
  } else if (slug === 'distance') {
    if (ex.target_value != null) {
      parts.push(`${ex.target_value}${ex.unit ? ` ${ex.unit}` : ''}`);
    }
  } else if (slug === 'weight') {
    if (ex.target_value != null) parts.push(`${ex.target_value}${ex.unit ? ` ${ex.unit}` : ''}`);
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
    if (ex.tempo) parts.push(t('training_plan_templates.summary_tempo', { tempo: ex.tempo }));
  } else {
    // repetitions, calories, rpe, rest_time, pace, speed, or no result type
    let reps: string | null = null;
    if (ex.min_reps != null && ex.max_reps != null) {
      reps = ex.min_reps === ex.max_reps ? String(ex.min_reps) : `${ex.min_reps}–${ex.max_reps}`;
    } else if (ex.min_reps != null) {
      reps = String(ex.min_reps);
    } else if (ex.max_reps != null) {
      reps = String(ex.max_reps);
    }
    if (slug && ex.target_value != null) {
      parts.push(`${ex.target_value}${ex.unit ? ` ${ex.unit}` : ''}`);
    } else {
      if (ex.sets != null && reps) parts.push(`${ex.sets} × ${reps}`);
      else if (ex.sets != null) parts.push(t('training_plan_templates.summary_sets', { n: ex.sets }));
      else if (reps) parts.push(reps);
    }
    if (ex.tempo) parts.push(t('training_plan_templates.summary_tempo', { tempo: ex.tempo }));
  }

  if (ex.rest_seconds != null) {
    const mins = ex.rest_seconds / 60;
    const display = Number.isInteger(mins) ? String(mins) : mins.toFixed(1);
    parts.push(t('block_exercises.rest_min', { n: display }));
  }
  return parts.join(' • ');
}

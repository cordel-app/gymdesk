import { isBlockFieldVisible } from './blockFieldConfig';

/* Block/exercise shapes shared by the Workout Template tree (#63) and the
 * Training Plan Template tree (#61) — both are fed by JSON_ARRAYAGG hierarchy
 * queries that emit these exact keys. */
export interface HierExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null;
  rest_seconds: number | null; tempo: string | null;
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

/** Compact exercise execution summary: sets × reps • Tempo • Rest. Nulls omitted. */
export function exerciseSummary(ex: HierExercise, t: TFn): string {
  const parts: string[] = [];
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
  if (ex.rest_seconds != null) parts.push(t('training_plan_templates.summary_rest_ex', { n: ex.rest_seconds }));
  return parts.join(' • ');
}

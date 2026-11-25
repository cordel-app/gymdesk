import { Tx } from '../infra/db';
import type { SupportedLocale as Locale } from '../infra/locale';
import { CascadeImportError, executeWorkoutPlan, planWorkoutTemplates, uniqueInOrder, type WorkoutPlan } from './workout-template-cascade';

export { CascadeImportError };

/**
 * #3337: the cascading import of System Training Plan Templates. A System
 * template names System Workout Templates, whose exercises are Base Exercises;
 * importing it imports or updates those Workout Templates and imports the
 * Base Exercises the gym is missing, and every gym-side relationship is
 * re-pointed at the gym's own records (Training Plan Template → gym Workout
 * Template, Workout Template → gym Exercise). Provenance stays in each copy's
 * `cloned_from_id` / `base_exercise_id`, never in the operational reference.
 *
 * `planCascadingImport()` is the one place that decides what will happen: the
 * preview route answers it and `cascadeImportTrainingPlanTemplates()` executes
 * the very same plan, recomputed inside its transaction, so what the
 * confirmation modal lists is what the import does. The Workout Template half
 * (planning, Exercise import, re-pointing) is `workout-template-cascade.ts`,
 * shared with the standalone Workout Template import (#3339).
 */

type Exec = Pick<Tx, 'query'>;

export interface CascadePlan {
  training_plan_templates: { id: number; name: string; action: 'create' | 'existing'; gym_template_id: number | null }[];
  workout_templates: { id: number; name: string; action: 'create' | 'update'; gym_template_id: number | null }[];
  /** Only the Base Exercises the gym does not have yet; the ones it has are reused silently. */
  exercises: { id: number; name: string }[];
}

/** Internal detail the executor needs beyond what the preview reports. */
interface PlanDetail {
  plan: CascadePlan;
  /** System Workout Template ids each Training Plan Template (by base id) links to. */
  tptLinks: Map<number, number[]>;
  workoutPlan: WorkoutPlan;
}

/**
 * #3334's copy of one template's workout list (order and weekday) onto another
 * — the one content copy Duplicate, Clone and Import share. The links still
 * name the source's Workout Templates; the import re-points them afterwards.
 */
export async function copyTemplateWorkoutsTx(tx: Tx, gymId: string, sourceId: number | string, targetId: number | string) {
  await tx.query(
    `INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday)
     SELECT ?, ?, workout_template_id, position, scheduled_weekday
       FROM training_plan_template_workouts WHERE training_plan_template_id = ? ORDER BY position ASC`,
    [gymId, targetId, sourceId],
  );
}

async function gymTrainingPlanCopy(exec: Exec, gymId: string, baseId: number, name: string): Promise<number | null> {
  const { rows } = await exec.query(
    `SELECT id FROM training_plan_templates
      WHERE gym_id = ? AND status != 'deleted' AND (cloned_from_id = ? OR name = ?)
      ORDER BY (cloned_from_id = ?) DESC, id ASC LIMIT 1`,
    [gymId, baseId, name, baseId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** The System Workout Templates a template links to, in its own order. */
async function systemWorkoutLinks(exec: Exec, templateId: number): Promise<number[]> {
  const { rows } = await exec.query(
    `SELECT tptw.workout_template_id AS id
       FROM training_plan_template_workouts tptw
       JOIN workout_templates wt ON wt.id = tptw.workout_template_id
      WHERE tptw.training_plan_template_id = ? AND wt.gym_id IS NULL AND wt.deleted_at IS NULL
      ORDER BY tptw.position ASC, tptw.id ASC`,
    [templateId],
  );
  return rows.map((r: any) => Number(r.id));
}

async function computePlan(exec: Exec, gymId: string, ids: number[], locale: Locale): Promise<PlanDetail> {
  const marks = ids.map(() => '?').join(', ');
  const { rows: bases } = await exec.query(
    `SELECT id, name FROM training_plan_templates
      WHERE id IN (${marks}) AND gym_id IS NULL AND status = 'active'`,
    ids,
  );
  const byId = new Map<number, any>(bases.map((b: any) => [Number(b.id), b]));
  const invalid = ids.filter((id) => !byId.has(id));
  if (invalid.length > 0) {
    throw new CascadeImportError('Some ids are not active System training plan templates', invalid);
  }

  // Training Plan Templates: a new copy takes the System template's links; a
  // copy the gym already has keeps its own, and only those still naming a
  // System Workout Template need re-pointing.
  const plan: CascadePlan = { training_plan_templates: [], workout_templates: [], exercises: [] };
  const tptLinks = new Map<number, number[]>();
  for (const id of ids) {
    const base = byId.get(id);
    const existing = await gymTrainingPlanCopy(exec, gymId, id, base.name);
    plan.training_plan_templates.push({ id, name: base.name, action: existing ? 'existing' : 'create', gym_template_id: existing });
    tptLinks.set(id, await systemWorkoutLinks(exec, existing ?? id));
  }

  // Workout Templates and their Exercises, deduplicated across the whole selection.
  const workoutPlan = await planWorkoutTemplates(exec, gymId, [...tptLinks.values()].flat(), locale, 'update');
  plan.workout_templates = workoutPlan.workout_templates.map((w) => ({
    id: w.id, name: w.name, action: w.action === 'create' ? 'create' : 'update', gym_template_id: w.gym_template_id,
  }));
  plan.exercises = workoutPlan.exercises;
  return { plan, tptLinks, workoutPlan };
}

/** The preview: what importing `ids` would create, update and import. Writes nothing. */
export async function planCascadingImport(exec: Exec, gymId: string, ids: number[], locale: Locale): Promise<CascadePlan> {
  return (await computePlan(exec, gymId, ids, locale)).plan;
}

export interface CascadeResult {
  imported: number[];
  skipped: number[];
  workout_templates: { created: number[]; updated: number[] };
  exercises: { imported: number[] };
}

/**
 * Executes the plan in the caller's transaction: Exercises first, then Workout
 * Templates (re-pointed at the gym's Exercises), then Training Plan Templates
 * (re-pointed at the gym's Workout Templates). A failure anywhere rolls the
 * whole cascade back.
 */
export async function cascadeImportTrainingPlanTemplates(
  tx: Tx, gymId: string, ids: number[], locale: Locale, actor: string | null,
): Promise<CascadeResult> {
  const { plan, tptLinks, workoutPlan } = await computePlan(tx, gymId, ids, locale);
  const result: CascadeResult = { imported: [], skipped: [], workout_templates: { created: [], updated: [] }, exercises: { imported: [] } };

  // 1–2. Exercises the gym is missing, then the Workout Templates re-pointed at them.
  const done = await executeWorkoutPlan(tx, gymId, workoutPlan, actor);
  result.exercises.imported = done.exercisesImported;
  result.workout_templates = { created: done.created, updated: done.updated };
  const workoutMap = done.workoutMap;

  // 3. Training Plan Templates: create the copy, then re-point its links.
  for (const tpt of plan.training_plan_templates) {
    let gymTptId: number;
    if (tpt.action === 'create') {
      const { rows } = await tx.query(
        'SELECT name, description, num_days FROM training_plan_templates WHERE id = ? AND gym_id IS NULL', [tpt.id],
      );
      const base = rows[0];
      const { insertId } = await tx.query(
        `INSERT INTO training_plan_templates
           (gym_id, name, description, num_days, status, created_by, modified_at, modified_by, cloned_from_id)
         VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), ?, ?)`,
        [gymId, base.name, base.description ?? null, base.num_days ?? 0, actor, actor, tpt.id],
      );
      gymTptId = Number(insertId);
      await copyTemplateWorkoutsTx(tx, gymId, tpt.id, gymTptId);
      result.imported.push(gymTptId);
    } else {
      gymTptId = tpt.gym_template_id as number;
      result.skipped.push(tpt.id);
    }
    for (const baseWtId of uniqueInOrder(tptLinks.get(tpt.id) ?? [])) {
      const gymWtId = workoutMap.get(baseWtId);
      if (gymWtId == null) continue;
      await tx.query(
        `UPDATE training_plan_template_workouts SET workout_template_id = ?
          WHERE training_plan_template_id = ? AND workout_template_id = ?`,
        [gymWtId, gymTptId, baseWtId],
      );
    }
  }
  return result;
}

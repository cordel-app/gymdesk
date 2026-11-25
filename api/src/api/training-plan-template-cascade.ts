import { Tx } from '../infra/db';
import type { SupportedLocale as Locale } from '../infra/locale';
import { workoutTemplateResyncChanges } from '../domain/workoutTemplateSync';
import { findGymExerciseForBase, insertGymExerciseFromBase, loadImportableBaseExercises } from './exercises';
import { copyTemplateBlocksTx } from './workout-templates';

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
 * confirmation modal lists is what the import does.
 */

type Exec = Pick<Tx, 'query'>;

export class CascadeImportError extends Error {
  status = 400;
  constructor(message: string, public invalid_ids: number[]) { super(message); }
}

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
  /** Base Exercise ids each Workout Template (by base id) will reference once imported/updated. */
  wtExercises: Map<number, number[]>;
  /** Every Base Exercise referenced, with the gym copy it already has (null = to import). */
  exerciseCopies: Map<number, number | null>;
  baseExercises: Map<number, any>;
}

function uniqueInOrder(values: number[]): number[] {
  return [...new Set(values)];
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

async function gymWorkoutCopy(exec: Exec, gymId: string, baseId: number, name: string): Promise<number | null> {
  const { rows } = await exec.query(
    `SELECT id FROM workout_templates
      WHERE gym_id = ? AND deleted_at IS NULL AND (cloned_from_id = ? OR name = ?)
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

/** The Base Exercises a Workout Template's live blocks still name, in order. */
async function baseExerciseRefs(exec: Exec, templateId: number): Promise<number[]> {
  const { rows } = await exec.query(
    `SELECT wte.base_exercise_id AS id
       FROM workout_template_exercises wte
       JOIN workout_template_blocks wtb ON wtb.id = wte.workout_template_block_id
      WHERE wtb.workout_template_id = ? AND wte.base_exercise_id IS NOT NULL
        AND wtb.deleted_at IS NULL AND wte.deleted_at IS NULL
      ORDER BY wtb.position ASC, wte.position ASC`,
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

  // Workout Templates, deduplicated across the whole selection.
  const wtIds = uniqueInOrder([...tptLinks.values()].flat());
  const wtExercises = new Map<number, number[]>();
  if (wtIds.length > 0) {
    const { rows: wts } = await exec.query(
      `SELECT id, name FROM workout_templates WHERE id IN (${wtIds.map(() => '?').join(', ')}) AND gym_id IS NULL`,
      wtIds,
    );
    const wtById = new Map<number, any>(wts.map((w: any) => [Number(w.id), w]));
    for (const id of wtIds) {
      const wt = wtById.get(id);
      const existing = await gymWorkoutCopy(exec, gymId, id, wt.name);
      plan.workout_templates.push({ id, name: wt.name, action: existing ? 'update' : 'create', gym_template_id: existing });
      // A new copy carries the System template's exercises; an existing copy's
      // blocks are the gym's own, so only its remaining Base references count.
      wtExercises.set(id, await baseExerciseRefs(exec, existing ?? id));
    }
  }

  // Exercises, deduplicated; only the ones the gym does not have are listed.
  const exIds = uniqueInOrder([...wtExercises.values()].flat());
  const baseExercises = await loadImportableBaseExercises(exec, exIds, locale);
  const exerciseCopies = new Map<number, number | null>();
  if (exIds.length > 0) {
    const { rows: names } = await exec.query(
      `SELECT id, name FROM base_exercises WHERE id IN (${exIds.map(() => '?').join(', ')})`,
      exIds,
    );
    const nameById = new Map<number, string>(names.map((r: any) => [Number(r.id), r.name]));
    for (const id of exIds) {
      const copy = await findGymExerciseForBase(exec, gymId, id, nameById.get(id) ?? '');
      exerciseCopies.set(id, copy ? Number(copy.id) : null);
      // An inactive Base Exercise cannot be imported; its references stay as they are.
      if (!copy && baseExercises.has(id)) {
        const src = baseExercises.get(id);
        plan.exercises.push({ id, name: src.display_name ?? src.name });
      }
    }
  }
  return { plan, tptLinks, wtExercises, exerciseCopies, baseExercises };
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
  const { plan, tptLinks, wtExercises, exerciseCopies, baseExercises } = await computePlan(tx, gymId, ids, locale);
  const result: CascadeResult = { imported: [], skipped: [], workout_templates: { created: [], updated: [] }, exercises: { imported: [] } };

  // 1. Exercises the gym is missing.
  const exerciseMap = new Map<number, number>();
  for (const [baseId, copyId] of exerciseCopies) {
    if (copyId != null) { exerciseMap.set(baseId, copyId); continue; }
    const src = baseExercises.get(baseId);
    if (!src) continue;
    const newId = await insertGymExerciseFromBase(tx, gymId, src, actor);
    exerciseMap.set(baseId, newId);
    result.exercises.imported.push(newId);
  }

  // 2. Workout Templates: create a copy, or update the one the gym has.
  const workoutMap = new Map<number, number>();
  for (const wt of plan.workout_templates) {
    let gymWtId: number;
    if (wt.action === 'create') {
      const { rows } = await tx.query(
        'SELECT name, description, notes FROM workout_templates WHERE id = ? AND gym_id IS NULL', [wt.id],
      );
      const base = rows[0];
      const { insertId } = await tx.query(
        `INSERT INTO workout_templates
           (gym_id, name, description, status, notes, created_by, modified_at, modified_by, cloned_from_id)
         VALUES (?, ?, ?, 'active', ?, ?, UTC_TIMESTAMP(), ?, ?)`,
        [gymId, base.name, base.description ?? null, base.notes ?? null, actor, actor, wt.id],
      );
      gymWtId = Number(insertId);
      await copyTemplateBlocksTx(tx, gymId, wt.id, gymWtId);
      result.workout_templates.created.push(gymWtId);
    } else {
      gymWtId = wt.gym_template_id as number;
      await resyncWorkoutCopy(tx, gymId, gymWtId, wt.id, actor);
      result.workout_templates.updated.push(gymWtId);
    }
    for (const baseExId of uniqueInOrder(wtExercises.get(wt.id) ?? [])) {
      const gymExId = exerciseMap.get(baseExId);
      if (gymExId == null) continue;
      await tx.query(
        `UPDATE workout_template_exercises wte
           JOIN workout_template_blocks wtb ON wtb.id = wte.workout_template_block_id
            SET wte.exercise_id = (SELECT id FROM exercises WHERE id = ? AND gym_id IS NOT NULL), wte.base_exercise_id = NULL
          WHERE wtb.workout_template_id = ? AND wte.base_exercise_id = ?`,
        [gymExId, gymWtId, baseExId],
      );
    }
    workoutMap.set(wt.id, gymWtId);
  }

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

/**
 * An existing Workout Template copy is "updated" by #3335's resync rule (name,
 * description and notes from its System template, never its blocks), applied
 * only where that rule applies: the copy names this System template as its
 * provenance, and the System name is not taken by another of the gym's
 * templates. A copy matched by name alone keeps its own fields.
 */
async function resyncWorkoutCopy(tx: Tx, gymId: string, copyId: number, baseId: number, actor: string | null) {
  const { rows: own } = await tx.query(
    'SELECT id, name, description, notes, cloned_from_id FROM workout_templates WHERE id = ? AND gym_id = ?', [copyId, gymId],
  );
  const copy = own[0];
  if (!copy || Number(copy.cloned_from_id) !== baseId) return;
  const { rows: baseRows } = await tx.query(
    'SELECT name, description, notes FROM workout_templates WHERE id = ? AND gym_id IS NULL', [baseId],
  );
  const base = baseRows[0];
  if (!base || workoutTemplateResyncChanges(copy, base).length === 0) return;
  let name = copy.name;
  if (copy.name !== base.name) {
    const { rows: taken } = await tx.query(
      'SELECT id FROM workout_templates WHERE gym_id = ? AND deleted_at IS NULL AND name = ? AND id <> ? LIMIT 1',
      [gymId, base.name, copyId],
    );
    if (taken.length === 0) name = base.name;
  }
  await tx.query(
    `UPDATE workout_templates SET name = ?, description = ?, notes = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id = ? AND gym_id = ?`,
    [name, base.description ?? null, base.notes ?? null, actor, copyId, gymId],
  );
}

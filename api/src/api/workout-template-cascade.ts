import { Tx } from '../infra/db';
import type { SupportedLocale as Locale } from '../infra/locale';
import { workoutTemplateResyncChanges } from '../domain/workoutTemplateSync';
import { findGymExerciseForBase, insertGymExerciseFromBase, loadImportableBaseExercises } from './exercises';
import { copyTemplateBlocksTx } from './workout-templates';

/**
 * #3339: the Workout Template half of a cascading import, shared by the
 * standalone `POST /workout-templates/import` and #3337's Training Plan
 * Template cascade (`training-plan-template-cascade.ts`), so both resolve a
 * Workout Template's Exercises by one rule. A System Workout Template's
 * exercises are Base Exercises; importing it imports the ones the gym lacks
 * (each once across the whole selection, through the Exercise import's own
 * writer) and re-points every reference of the gym copy at the gym's own
 * Exercise, provenance staying in the gym Exercise's `base_exercise_id`.
 *
 * `planWorkoutTemplates()` decides; `executeWorkoutPlan()` performs that same
 * plan, so a preview and the import cannot disagree.
 */

type Exec = Pick<Tx, 'query'>;

export class CascadeImportError extends Error {
  status = 400;
  constructor(message: string, public invalid_ids: number[]) { super(message); }
}

/**
 * What to do with a System Workout Template the gym already holds a copy of:
 * `update` (the Training Plan cascade: #3335's resync rule, then re-point its
 * remaining Base references) or `skip` (the standalone import, unchanged since
 * #3335: the copy is left exactly as it is).
 */
export type ExistingWorkoutCopy = 'update' | 'skip';

export interface WorkoutPlanEntry {
  id: number;
  name: string;
  action: 'create' | 'update' | 'existing';
  gym_template_id: number | null;
}

export interface WorkoutPlan {
  workout_templates: WorkoutPlanEntry[];
  /** Only the Base Exercises the gym does not have yet; the ones it has are reused silently. */
  exercises: { id: number; name: string }[];
  /** Base Exercise ids each Workout Template (by base id) will reference once imported/updated. */
  wtExercises: Map<number, number[]>;
  /** Every Base Exercise referenced, with the gym copy it already has (null = to import). */
  exerciseCopies: Map<number, number | null>;
  baseExercises: Map<number, any>;
}

export function uniqueInOrder(values: number[]): number[] {
  return [...new Set(values)];
}

export async function gymWorkoutCopy(exec: Exec, gymId: string, baseId: number, name: string): Promise<number | null> {
  const { rows } = await exec.query(
    `SELECT id FROM workout_templates
      WHERE gym_id = ? AND deleted_at IS NULL AND (cloned_from_id = ? OR name = ?)
      ORDER BY (cloned_from_id = ?) DESC, id ASC LIMIT 1`,
    [gymId, baseId, name, baseId],
  );
  return rows[0] ? Number(rows[0].id) : null;
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

/**
 * The plan for a set of System Workout Template ids (already validated, in
 * order, de-duplicated by the caller or here). Writes nothing.
 */
export async function planWorkoutTemplates(
  exec: Exec, gymId: string, wtIds: number[], locale: Locale, existing: ExistingWorkoutCopy,
): Promise<WorkoutPlan> {
  const ids = uniqueInOrder(wtIds);
  const plan: WorkoutPlan = {
    workout_templates: [], exercises: [], wtExercises: new Map(), exerciseCopies: new Map(), baseExercises: new Map(),
  };
  if (ids.length > 0) {
    const { rows: wts } = await exec.query(
      `SELECT id, name FROM workout_templates WHERE id IN (${ids.map(() => '?').join(', ')}) AND gym_id IS NULL`,
      ids,
    );
    const wtById = new Map<number, any>(wts.map((w: any) => [Number(w.id), w]));
    for (const id of ids) {
      const wt = wtById.get(id);
      if (!wt) continue;
      const copy = await gymWorkoutCopy(exec, gymId, id, wt.name);
      if (copy && existing === 'skip') {
        plan.workout_templates.push({ id, name: wt.name, action: 'existing', gym_template_id: copy });
        continue;
      }
      plan.workout_templates.push({ id, name: wt.name, action: copy ? 'update' : 'create', gym_template_id: copy });
      // A new copy carries the System template's exercises; an existing copy's
      // blocks are the gym's own, so only its remaining Base references count.
      plan.wtExercises.set(id, await baseExerciseRefs(exec, copy ?? id));
    }
  }

  // Exercises, deduplicated; only the ones the gym does not have are listed.
  const exIds = uniqueInOrder([...plan.wtExercises.values()].flat());
  plan.baseExercises = await loadImportableBaseExercises(exec, exIds, locale);
  if (exIds.length > 0) {
    const { rows: names } = await exec.query(
      `SELECT id, name FROM base_exercises WHERE id IN (${exIds.map(() => '?').join(', ')})`,
      exIds,
    );
    const nameById = new Map<number, string>(names.map((r: any) => [Number(r.id), r.name]));
    for (const id of exIds) {
      const copy = await findGymExerciseForBase(exec, gymId, id, nameById.get(id) ?? '');
      plan.exerciseCopies.set(id, copy ? Number(copy.id) : null);
      // An inactive Base Exercise cannot be imported; its references stay as they are.
      if (!copy && plan.baseExercises.has(id)) {
        const src = plan.baseExercises.get(id);
        plan.exercises.push({ id, name: src.display_name ?? src.name });
      }
    }
  }
  return plan;
}

export interface WorkoutPlanResult {
  /** System Workout Template id → the gym copy every link should name. */
  workoutMap: Map<number, number>;
  created: number[];
  updated: number[];
  /** System ids whose existing copy was left untouched (`skip`). */
  skipped: number[];
  exercisesImported: number[];
}

/**
 * Executes a plan in the caller's transaction: Exercises first, then the
 * Workout Templates, each re-pointed at the gym's Exercises.
 */
export async function executeWorkoutPlan(
  tx: Tx, gymId: string, plan: WorkoutPlan, actor: string | null,
): Promise<WorkoutPlanResult> {
  const result: WorkoutPlanResult = { workoutMap: new Map(), created: [], updated: [], skipped: [], exercisesImported: [] };

  // 1. Exercises the gym is missing.
  const exerciseMap = new Map<number, number>();
  for (const [baseId, copyId] of plan.exerciseCopies) {
    if (copyId != null) { exerciseMap.set(baseId, copyId); continue; }
    const src = plan.baseExercises.get(baseId);
    if (!src) continue;
    const newId = await insertGymExerciseFromBase(tx, gymId, src, actor);
    exerciseMap.set(baseId, newId);
    result.exercisesImported.push(newId);
  }

  // 2. Workout Templates: create a copy, update the one the gym has, or leave it.
  for (const wt of plan.workout_templates) {
    let gymWtId: number;
    if (wt.action === 'existing') {
      result.workoutMap.set(wt.id, wt.gym_template_id as number);
      result.skipped.push(wt.id);
      continue;
    }
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
      result.created.push(gymWtId);
    } else {
      gymWtId = wt.gym_template_id as number;
      await resyncWorkoutCopy(tx, gymId, gymWtId, wt.id, actor);
      result.updated.push(gymWtId);
    }
    for (const baseExId of uniqueInOrder(plan.wtExercises.get(wt.id) ?? [])) {
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
    result.workoutMap.set(wt.id, gymWtId);
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

/* ── #3339: the standalone import ─────────────────────────────────────────── */

export interface WorkoutImportPreview {
  workout_templates: { id: number; name: string; action: 'create' | 'existing'; gym_template_id: number | null }[];
  exercises: { id: number; name: string }[];
}

async function validatedPlan(exec: Exec, gymId: string, ids: number[], locale: Locale): Promise<WorkoutPlan> {
  const { rows: bases } = await exec.query(
    `SELECT id FROM workout_templates
      WHERE id IN (${ids.map(() => '?').join(', ')}) AND gym_id IS NULL AND status = 'active' AND deleted_at IS NULL`,
    ids,
  );
  const found = new Set(bases.map((b: any) => Number(b.id)));
  const invalid = ids.filter((id) => !found.has(id));
  if (invalid.length > 0) throw new CascadeImportError('Some ids are not active System workout templates', invalid);
  return planWorkoutTemplates(exec, gymId, ids, locale, 'skip');
}

/** `POST /workout-templates/import/preview`: what importing `ids` would do. Writes nothing. */
export async function planWorkoutTemplateImport(exec: Exec, gymId: string, ids: number[], locale: Locale): Promise<WorkoutImportPreview> {
  const plan = await validatedPlan(exec, gymId, ids, locale);
  return {
    workout_templates: plan.workout_templates.map((w) => ({
      id: w.id, name: w.name, action: w.action === 'existing' ? 'existing' : 'create', gym_template_id: w.gym_template_id,
    })),
    exercises: plan.exercises,
  };
}

export interface WorkoutImportResult {
  imported: number[];
  skipped: number[];
  exercises: { imported: number[] };
}

/** `POST /workout-templates/import`: the same plan, executed in the caller's transaction. */
export async function importWorkoutTemplatesCascade(
  tx: Tx, gymId: string, ids: number[], locale: Locale, actor: string | null,
): Promise<WorkoutImportResult> {
  const plan = await validatedPlan(tx, gymId, ids, locale);
  const done = await executeWorkoutPlan(tx, gymId, plan, actor);
  return { imported: done.created, skipped: done.skipped, exercises: { imported: done.exercisesImported } };
}

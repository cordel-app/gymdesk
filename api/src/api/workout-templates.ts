import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { getReferences } from '../domain/references';

/**
 * #55: WorkoutTemplate -> WorkoutTemplateBlock -> WorkoutTemplateExercise.
 * Reusable session hierarchy, independently CRUD-able, referenced by
 * TrainingPlanTemplate via the training_plan_template_workouts junction
 * (see training-plan-templates.ts) and cloned into Workout/WorkoutBlock/
 * WorkoutExercise on assignment (see training-plans.ts).
 *
 * #62: templates carry a status (active/inactive/deleted). Soft delete sets
 * status='deleted' together with deleted_at; deleted_at IS NULL stays the
 * canonical read filter. Selectors pass ?status=active so inactive templates
 * are kept out of new associations.
 */

export const workoutTemplatesRouter = Router();

const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];
const RESULT_TYPES = ['None', 'Time', 'Rounds', 'Repetitions', 'Distance', 'Calories', 'Weight', 'Score'];
const SETTABLE_STATUSES = ['active', 'inactive'];

async function templateExists(id: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM workout_templates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [id, gymId],
  );
  return rows.length > 0;
}

async function blockExists(blockId: string, templateId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM workout_template_blocks WHERE id = ? AND workout_template_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [blockId, templateId, gymId],
  );
  return rows.length > 0;
}

function parseBlockBody(body: any):
  | { name: string | null; description: string | null; type: string; result_type: string;
      rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
      is_optional: boolean; notes: string | null }
  | string
{
  const { name, description, type, result_type, rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes } = body;
  if (!type || !BLOCK_TYPES.includes(type)) return `type must be one of: ${BLOCK_TYPES.join(', ')}`;
  const rt = result_type ?? 'None';
  if (!RESULT_TYPES.includes(rt)) return `result_type must be one of: ${RESULT_TYPES.join(', ')}`;
  const toIntOrNull = (v: any) => (v == null || v === '' ? null : Number(v));
  return {
    name: name?.trim() || null,
    description: description ?? null,
    type,
    result_type: rt,
    rounds: toIntOrNull(rounds),
    duration_seconds: toIntOrNull(duration_seconds),
    work_seconds: toIntOrNull(work_seconds),
    rest_seconds: toIntOrNull(rest_seconds),
    is_optional: Boolean(is_optional),
    notes: notes ?? null,
  };
}

function parseExerciseItemBody(body: any):
  | { exercise_id: number; min_reps: number | null; max_reps: number | null; sets: number | null; rest_seconds: number | null; tempo: string | null }
  | string
{
  const exerciseId = Number(body.exercise_id);
  if (!Number.isInteger(exerciseId) || exerciseId <= 0) return 'exercise_id is required';
  const toIntOrNull = (v: any) => (v == null || v === '' ? null : Number(v));
  return {
    exercise_id: exerciseId,
    min_reps: toIntOrNull(body.min_reps),
    max_reps: toIntOrNull(body.max_reps),
    sets: toIntOrNull(body.sets),
    rest_seconds: toIntOrNull(body.rest_seconds),
    tempo: body.tempo?.trim() || null,
  };
}

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

/* ---- WorkoutTemplate ---- */

workoutTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  try {
    const params: any[] = [gymId];
    let sql = 'SELECT * FROM workout_templates WHERE gym_id = ? AND deleted_at IS NULL';
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY name ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** #62: where this template is used (non-deleted training plan templates). */
workoutTemplatesRouter.get('/:id/references', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json(await getReferences('workout_template', gymId, Number(req.params.id)));
  } catch (err) { next(err); }
});

workoutTemplatesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    // MySQL's JSON_ARRAYAGG has no ORDER BY of its own — aggregate over a
    // derived table pre-sorted by position instead.
    const { rows } = await db.query(
      `SELECT wt.*,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', b.id, 'position', b.position, 'name', b.name, 'description', b.description,
              'type', b.type, 'result_type', b.result_type, 'rounds', b.rounds,
              'duration_seconds', b.duration_seconds, 'work_seconds', b.work_seconds, 'rest_seconds', b.rest_seconds,
              'is_optional', b.is_optional, 'notes', b.notes,
              'exercises', (SELECT JSON_ARRAYAGG(item) FROM (
                SELECT JSON_OBJECT(
                    'id', wte.id, 'position', wte.position, 'exercise_id', wte.exercise_id,
                    'exercise_name', e.name, 'min_reps', wte.min_reps, 'max_reps', wte.max_reps,
                    'sets', wte.sets, 'rest_seconds', wte.rest_seconds, 'tempo', wte.tempo) AS item
                FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id
                WHERE wte.workout_template_block_id = b.id AND wte.deleted_at IS NULL
                ORDER BY wte.position
              ) t2)
            ) AS item
          FROM workout_template_blocks b WHERE b.workout_template_id = wt.id AND b.deleted_at IS NULL
          ORDER BY b.position
        ) t1) AS blocks
       FROM workout_templates wt WHERE wt.id = ? AND wt.gym_id = ? AND wt.deleted_at IS NULL`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workout template not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO workout_templates (gym_id, name, description, status) VALUES (?, ?, ?, ?)',
      [gymId, name.trim(), description ?? null, status ?? 'active'],
    );
    const { rows } = await db.query('SELECT * FROM workout_templates WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'workout_template', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE workout_templates SET name = COALESCE(?, name), description = IF(?, ?, description),
              status = COALESCE(?, status)
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Workout template not found' });
    const { rows } = await db.query('SELECT * FROM workout_templates WHERE id = ? AND gym_id = ?', [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'workout_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { rowCount } = await db.query(
    "UPDATE workout_templates SET deleted_at = UTC_TIMESTAMP(), status = 'deleted' WHERE id = ? AND gym_id = ? AND deleted_at IS NULL",
    [id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Workout template not found' });
  recordAudit(req, { action: 'delete', entityType: 'workout_template', entityId: id });
  res.status(204).send();
});

/* ---- WorkoutTemplateBlock ---- */

workoutTemplatesRouter.get('/:id/blocks', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Workout template not found' });
    const { rows } = await db.query(
      'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND gym_id = ? AND deleted_at IS NULL ORDER BY position ASC',
      [id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.post('/:id/blocks', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Workout template not found' });
  const parsed = parseBlockBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_template_blocks WHERE workout_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      `INSERT INTO workout_template_blocks
        (gym_id, workout_template_id, position, name, description, type, result_type,
         rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, id, posRows[0].next_position, parsed.name, parsed.description, parsed.type, parsed.result_type,
       parsed.rounds, parsed.duration_seconds, parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes,
       gymMembershipId],
    );
    const { rows } = await db.query('SELECT * FROM workout_template_blocks WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'workout_template_block', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/reorder', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Workout template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of block ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workout_template_blocks', 'workout_template_id', id, order));
    const { rows } = await db.query(
      'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND gym_id = ? AND deleted_at IS NULL ORDER BY position ASC',
      [id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/:blockId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Workout template not found' });
  const parsed = parseBlockBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rowCount } = await db.query(
      `UPDATE workout_template_blocks SET
        name = ?, description = ?, type = ?, result_type = ?, rounds = ?, duration_seconds = ?,
        work_seconds = ?, rest_seconds = ?, is_optional = ?, notes = ?,
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND workout_template_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [parsed.name, parsed.description, parsed.type, parsed.result_type, parsed.rounds, parsed.duration_seconds,
       parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes, gymMembershipId,
       blockId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Block not found' });
    const { rows } = await db.query('SELECT * FROM workout_template_blocks WHERE id = ?', [blockId]);
    recordAudit(req, { action: 'update', entityType: 'workout_template_block', entityId: blockId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.delete('/:id/blocks/:blockId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  const { rowCount } = await db.query(
    'UPDATE workout_template_blocks SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND workout_template_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [blockId, id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Block not found' });
  recordAudit(req, { action: 'delete', entityType: 'workout_template_block', entityId: blockId });
  res.status(204).send();
});

/* ---- WorkoutTemplateExercise ---- */

workoutTemplatesRouter.get('/:id/blocks/:blockId/exercises', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  try {
    if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
    const { rows } = await db.query(
      `SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte
       JOIN exercises e ON e.id = wte.exercise_id
       WHERE wte.workout_template_block_id = ? AND wte.gym_id = ? AND wte.deleted_at IS NULL
       ORDER BY wte.position ASC`,
      [blockId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.post('/:id/blocks/:blockId/exercises', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
  const parsed = parseExerciseItemBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: exRows } = await db.query('SELECT 1 FROM exercises WHERE id = ? AND gym_id = ?', [parsed.exercise_id, gymId]);
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id does not belong to this gym' });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_template_exercises WHERE workout_template_block_id = ?',
      [blockId],
    );
    const { insertId } = await db.query(
      `INSERT INTO workout_template_exercises
        (gym_id, workout_template_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, blockId, parsed.exercise_id, posRows[0].next_position, parsed.min_reps, parsed.max_reps,
       parsed.sets, parsed.rest_seconds, parsed.tempo, gymMembershipId],
    );
    const { rows } = await db.query(
      'SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id WHERE wte.id = ?',
      [insertId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template_exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/:blockId/exercises/reorder', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of exercise-item ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workout_template_exercises', 'workout_template_block_id', blockId, order));
    const { rows } = await db.query(
      'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND gym_id = ? AND deleted_at IS NULL ORDER BY position ASC',
      [blockId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/:blockId/exercises/:exId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId, exId } = req.params as { id: string; blockId: string; exId: string };
  if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
  const parsed = parseExerciseItemBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: exRows } = await db.query('SELECT 1 FROM exercises WHERE id = ? AND gym_id = ?', [parsed.exercise_id, gymId]);
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id does not belong to this gym' });
    const { rowCount } = await db.query(
      `UPDATE workout_template_exercises SET
        exercise_id = ?, min_reps = ?, max_reps = ?, sets = ?, rest_seconds = ?, tempo = ?,
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND workout_template_block_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [parsed.exercise_id, parsed.min_reps, parsed.max_reps, parsed.sets, parsed.rest_seconds, parsed.tempo, gymMembershipId,
       exId, blockId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Exercise item not found' });
    const { rows } = await db.query(
      'SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id WHERE wte.id = ?',
      [exId],
    );
    recordAudit(req, { action: 'update', entityType: 'workout_template_exercise', entityId: exId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.delete('/:id/blocks/:blockId/exercises/:exId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { blockId, exId } = req.params as { id: string; blockId: string; exId: string };
  const { rowCount } = await db.query(
    'UPDATE workout_template_exercises SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND workout_template_block_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [exId, blockId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise item not found' });
  recordAudit(req, { action: 'delete', entityType: 'workout_template_exercise', entityId: exId });
  res.status(204).send();
});

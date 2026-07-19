import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';

/**
 * #55: the clone/assigned-plan hierarchy — TrainingPlan -> Workout ->
 * WorkoutBlock -> WorkoutExercise. Mounted at /members/:memberId/training-plans
 * (mergeParams: true). A TrainingPlan is created either by cloning a
 * TrainingPlanTemplate or from scratch (see member-training-plans.ts's
 * assign transaction); once assigned a trainer can freely restructure it via
 * the full nested CRUD below — editing here never touches the original
 * template. Mirrors workout-templates.ts's structure exactly.
 */

export const trainingPlansRouter = Router({ mergeParams: true });

const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];
// null = unlimited
const BLOCK_TYPE_MAX_EXERCISES: Record<string, number | null> = {
  Standard: 1, Superset: 2, Triset: 3,
  GiantSet: null, Circuit: null, EMOM: null, AMRAP: null, Tabata: null,
};
const RESULT_TYPES = ['None', 'Time', 'Rounds', 'Repetitions', 'Distance', 'Calories', 'Weight', 'Score'];
// #67 lifecycle: draft/active/expired/completed/deleted ('inactive' remapped to 'expired' in migration 054)
// #112: 'completed' added for explicit trainer-initiated plan completion
const PLAN_STATUSES = ['draft', 'active', 'expired', 'completed', 'deleted'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

async function planExists(planId: string, memberId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM training_plans WHERE id = ? AND member_id = ? AND gym_id = ? AND status != 'deleted'",
    [planId, memberId, gymId],
  );
  return rows.length > 0;
}

async function assertPlanWritable(planId: string, memberId: string, gymId: string): Promise<void> {
  const { rows } = await db.query(
    "SELECT status FROM training_plans WHERE id = ? AND member_id = ? AND gym_id = ? AND status != 'deleted'",
    [planId, memberId, gymId],
  );
  if (rows.length === 0) throw Object.assign(new Error('Training plan not found'), { status: 404 });
  if (rows[0].status === 'completed') throw Object.assign(new Error('Completed training plans are read-only'), { status: 403 });
}

async function workoutExists(workoutId: string, planId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM workouts WHERE id = ? AND training_plan_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [workoutId, planId, gymId],
  );
  return rows.length > 0;
}

async function blockExists(blockId: string, workoutId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM workout_blocks WHERE id = ? AND workout_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [blockId, workoutId, gymId],
  );
  return rows.length > 0;
}

function parseBlockBody(body: Record<string, unknown>):
  | { name: string | null; description: string | null; type: string; result_type: string;
      rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
      is_optional: boolean; notes: string | null }
  | string
{
  const name = body.name as string | null | undefined;
  const description = body.description as string | null | undefined;
  const type = body.type as string | undefined;
  const result_type = body.result_type as string | undefined;
  const notes = body.notes as string | null | undefined;
  if (!type || !BLOCK_TYPES.includes(type)) return `type must be one of: ${BLOCK_TYPES.join(', ')}`;
  const rt = result_type ?? 'None';
  if (!RESULT_TYPES.includes(rt)) return `result_type must be one of: ${RESULT_TYPES.join(', ')}`;
  const toIntOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
  return {
    name: name?.trim() || null,
    description: description ?? null,
    type,
    result_type: rt,
    rounds: toIntOrNull(body.rounds),
    duration_seconds: toIntOrNull(body.duration_seconds),
    work_seconds: toIntOrNull(body.work_seconds),
    rest_seconds: toIntOrNull(body.rest_seconds),
    is_optional: Boolean(body.is_optional),
    notes: notes ?? null,
  };
}

function parseExerciseItemBody(body: Record<string, unknown>):
  | { exercise_id: number; min_reps: number | null; max_reps: number | null; sets: number | null; rest_seconds: number | null; tempo: string | null; notes: string | null }
  | string
{
  const exerciseId = Number(body.exercise_id);
  if (!Number.isInteger(exerciseId) || exerciseId <= 0) return 'exercise_id is required';
  const toIntOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const tempo = body.tempo as string | null | undefined;
  const notes = body.notes as string | null | undefined;
  return {
    exercise_id: exerciseId,
    min_reps: toIntOrNull(body.min_reps),
    max_reps: toIntOrNull(body.max_reps),
    sets: toIntOrNull(body.sets),
    rest_seconds: toIntOrNull(body.rest_seconds),
    tempo: tempo?.trim() || null,
    notes: notes ?? null,
  };
}

// MySQL's JSON_ARRAYAGG has no ORDER BY clause of its own — each level aggregates
// over a derived table that is pre-sorted by position, not the aggregate itself.
export const PLAN_TREE_SELECT = `
  SELECT tp.*,
    (SELECT JSON_ARRAYAGG(item) FROM (
      SELECT JSON_OBJECT(
          'id', w.id, 'position', w.position, 'name', w.name, 'description', w.description,
          'scheduled_weekday', w.scheduled_weekday,
          'blocks', (SELECT JSON_ARRAYAGG(item) FROM (
            SELECT JSON_OBJECT(
                'id', b.id, 'position', b.position, 'name', b.name, 'description', b.description,
                'type', b.type, 'result_type', b.result_type, 'rounds', b.rounds,
                'duration_seconds', b.duration_seconds, 'work_seconds', b.work_seconds, 'rest_seconds', b.rest_seconds,
                'is_optional', b.is_optional, 'notes', b.notes,
                'exercises', (SELECT JSON_ARRAYAGG(item) FROM (
                  SELECT JSON_OBJECT(
                      'id', we.id, 'position', we.position, 'exercise_id', we.exercise_id, 'exercise_name', e.name,
                      'min_reps', we.min_reps, 'max_reps', we.max_reps, 'sets', we.sets,
                      'rest_seconds', we.rest_seconds, 'tempo', we.tempo, 'notes', we.notes) AS item
                  FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
                  WHERE we.workout_block_id = b.id AND we.deleted_at IS NULL
                  ORDER BY we.position
                ) t3)
              ) AS item
            FROM workout_blocks b WHERE b.workout_id = w.id AND b.deleted_at IS NULL
            ORDER BY b.position
          ) t2)
        ) AS item
      FROM workouts w WHERE w.training_plan_id = tp.id AND w.deleted_at IS NULL
      ORDER BY w.position
    ) t1) AS workouts
  FROM training_plans tp
`;

/* ---- TrainingPlan ---- */

trainingPlansRouter.get('/:planId', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  try {
    const { rows } = await db.query(
      `${PLAN_TREE_SELECT} WHERE tp.id = ? AND tp.member_id = ? AND tp.gym_id = ? AND tp.status != 'deleted'`,
      [planId, memberId, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  const { name, description, status, start_date, end_date } = req.body;
  const EDITABLE_STATUSES = PLAN_STATUSES.filter((s) => s !== 'deleted' && s !== 'completed');
  if (status && !EDITABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${EDITABLE_STATUSES.join(', ')} (use POST /complete to complete a plan)` });
  }
  if (start_date != null && !(typeof start_date === 'string' && DATE_RE.test(start_date))) {
    return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' });
  }
  if (end_date != null && !(typeof end_date === 'string' && DATE_RE.test(end_date))) {
    return res.status(400).json({ error: 'end_date must be YYYY-MM-DD' });
  }
  try {
    await assertPlanWritable(planId, memberId, gymId);
    const { rowCount } = await db.query(
      `UPDATE training_plans SET
        name = COALESCE(?, name), description = IF(?, ?, description), status = COALESCE(?, status),
        start_date = COALESCE(?, start_date), end_date = IF(?, ?, end_date),
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND member_id = ? AND gym_id = ? AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null,
       start_date ?? null, 'end_date' in req.body ? 1 : 0, end_date ?? null, gymMembershipId,
       planId, memberId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Training plan not found' });
    const { rows } = await db.query(`${PLAN_TREE_SELECT} WHERE tp.id = ?`, [planId]);
    recordAudit(req, { action: 'update', entityType: 'training_plan', entityId: planId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.delete('/:planId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  const { rowCount } = await db.query(
    "UPDATE training_plans SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ? AND member_id = ? AND gym_id = ? AND status != 'deleted'",
    [planId, memberId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Training plan not found' });
  recordAudit(req, { action: 'delete', entityType: 'training_plan', entityId: planId });
  res.status(204).send();
});

/* ---- Workout (clone-side) ---- */

trainingPlansRouter.post('/:planId/workouts', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  try { await assertPlanWritable(planId, memberId, gymId); } catch (e: any) { return res.status(e.status ?? 500).json({ error: e.message }); }
  const { name, description, scheduled_weekday } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const weekday = scheduled_weekday == null || scheduled_weekday === '' ? null : Number(scheduled_weekday);
  if (weekday !== null && (weekday < 0 || weekday > 6)) return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workouts WHERE training_plan_id = ?',
      [planId],
    );
    const row = await insertAndFetch(
      'INSERT INTO workouts (gym_id, training_plan_id, name, description, position, scheduled_weekday) VALUES (?, ?, ?, ?, ?, ?)',
      [gymId, planId, name.trim(), description ?? null, posRows[0].next_position, weekday],
      'SELECT * FROM workouts WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'workout', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId/workouts/reorder', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  try { await assertPlanWritable(planId, memberId, gymId); } catch (e: any) { return res.status(e.status ?? 500).json({ error: e.message }); }
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of workout ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workouts', 'training_plan_id', planId, order));
    const { rows } = await db.query(
      'SELECT * FROM workouts WHERE training_plan_id = ? AND gym_id = ? AND deleted_at IS NULL ORDER BY position ASC',
      [planId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId/workouts/:workoutId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId, planId, workoutId } = req.params as { memberId: string; planId: string; workoutId: string };
  try { await assertPlanWritable(planId, memberId, gymId); } catch (e: any) { return res.status(e.status ?? 500).json({ error: e.message }); }
  const { name, description, scheduled_weekday } = req.body;
  const weekday = scheduled_weekday == null || scheduled_weekday === '' ? null : Number(scheduled_weekday);
  if (weekday !== null && (weekday < 0 || weekday > 6)) return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  try {
    const { rowCount } = await db.query(
      `UPDATE workouts SET name = COALESCE(?, name), description = IF(?, ?, description), scheduled_weekday = ?
       WHERE id = ? AND training_plan_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, weekday, workoutId, planId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Workout not found' });
    const { rows } = await db.query('SELECT * FROM workouts WHERE id = ?', [workoutId]);
    recordAudit(req, { action: 'update', entityType: 'workout', entityId: workoutId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.delete('/:planId/workouts/:workoutId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { planId, workoutId } = req.params as { planId: string; workoutId: string };
  const { rowCount } = await db.query(
    'UPDATE workouts SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND training_plan_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [workoutId, planId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Workout not found' });
  recordAudit(req, { action: 'delete', entityType: 'workout', entityId: workoutId });
  res.status(204).send();
});

/* ---- WorkoutBlock (clone-side) ---- */

trainingPlansRouter.post('/:planId/workouts/:workoutId/blocks', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { planId, workoutId } = req.params as { planId: string; workoutId: string };
  if (!(await workoutExists(workoutId, planId, gymId))) return res.status(404).json({ error: 'Workout not found' });
  const parsed = parseBlockBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_blocks WHERE workout_id = ?',
      [workoutId],
    );
    const row = await insertAndFetch(
      `INSERT INTO workout_blocks
        (gym_id, workout_id, position, name, description, type, result_type,
         rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, workoutId, posRows[0].next_position, parsed.name, parsed.description, parsed.type, parsed.result_type,
       parsed.rounds, parsed.duration_seconds, parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes,
       gymMembershipId],
      'SELECT * FROM workout_blocks WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_block', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId/workouts/:workoutId/blocks/reorder', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { planId, workoutId } = req.params as { planId: string; workoutId: string };
  if (!(await workoutExists(workoutId, planId, gymId))) return res.status(404).json({ error: 'Workout not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of block ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workout_blocks', 'workout_id', workoutId, order));
    const { rows } = await db.query(
      'SELECT * FROM workout_blocks WHERE workout_id = ? AND gym_id = ? AND deleted_at IS NULL ORDER BY position ASC',
      [workoutId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId/workouts/:workoutId/blocks/:blockId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { planId, workoutId, blockId } = req.params as { planId: string; workoutId: string; blockId: string };
  if (!(await workoutExists(workoutId, planId, gymId))) return res.status(404).json({ error: 'Workout not found' });
  const parsed = parseBlockBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rowCount } = await db.query(
      `UPDATE workout_blocks SET
        name = ?, description = ?, type = ?, result_type = ?, rounds = ?, duration_seconds = ?,
        work_seconds = ?, rest_seconds = ?, is_optional = ?, notes = ?,
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND workout_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [parsed.name, parsed.description, parsed.type, parsed.result_type, parsed.rounds, parsed.duration_seconds,
       parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes, gymMembershipId,
       blockId, workoutId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Block not found' });
    const { rows } = await db.query('SELECT * FROM workout_blocks WHERE id = ?', [blockId]);
    recordAudit(req, { action: 'update', entityType: 'workout_block', entityId: blockId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.delete('/:planId/workouts/:workoutId/blocks/:blockId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { workoutId, blockId } = req.params as { workoutId: string; blockId: string };
  const { rowCount } = await db.query(
    'UPDATE workout_blocks SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND workout_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [blockId, workoutId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Block not found' });
  recordAudit(req, { action: 'delete', entityType: 'workout_block', entityId: blockId });
  res.status(204).send();
});

/* ---- WorkoutExercise (clone-side) ---- */

trainingPlansRouter.post('/:planId/workouts/:workoutId/blocks/:blockId/exercises', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { workoutId, blockId } = req.params as { workoutId: string; blockId: string };
  if (!(await blockExists(blockId, workoutId, gymId))) return res.status(404).json({ error: 'Block not found' });
  const parsed = parseExerciseItemBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: blockRows } = await db.query(
      `SELECT b.type, COUNT(we.id) AS ex_count
       FROM workout_blocks b
       LEFT JOIN workout_exercises we ON we.workout_block_id = b.id AND we.deleted_at IS NULL
       WHERE b.id = ?
       GROUP BY b.id`,
      [blockId],
    );
    const maxEx = BLOCK_TYPE_MAX_EXERCISES[blockRows[0].type];
    if (maxEx !== null && blockRows[0].ex_count >= maxEx) {
      return res.status(422).json({
        error: 'MaximumExercisesExceeded',
        message: `Block type '${blockRows[0].type}' allows a maximum of ${maxEx} exercises.`,
      });
    }
    const { rows: exRows } = await db.query('SELECT 1 FROM exercises WHERE id = ? AND gym_id = ?', [parsed.exercise_id, gymId]);
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id does not belong to this gym' });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_exercises WHERE workout_block_id = ?',
      [blockId],
    );
    const row = await insertAndFetch(
      `INSERT INTO workout_exercises
        (gym_id, workout_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, blockId, parsed.exercise_id, posRows[0].next_position, parsed.min_reps, parsed.max_reps,
       parsed.sets, parsed.rest_seconds, parsed.tempo, parsed.notes, gymMembershipId],
      'SELECT we.*, e.name AS exercise_name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_exercise', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId/workouts/:workoutId/blocks/:blockId/exercises/reorder', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { workoutId, blockId } = req.params as { workoutId: string; blockId: string };
  if (!(await blockExists(blockId, workoutId, gymId))) return res.status(404).json({ error: 'Block not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of exercise-item ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workout_exercises', 'workout_block_id', blockId, order));
    const { rows } = await db.query(
      'SELECT * FROM workout_exercises WHERE workout_block_id = ? AND gym_id = ? AND deleted_at IS NULL ORDER BY position ASC',
      [blockId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.put('/:planId/workouts/:workoutId/blocks/:blockId/exercises/:exId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { workoutId, blockId, exId } = req.params as { workoutId: string; blockId: string; exId: string };
  if (!(await blockExists(blockId, workoutId, gymId))) return res.status(404).json({ error: 'Block not found' });
  const parsed = parseExerciseItemBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: exRows } = await db.query('SELECT 1 FROM exercises WHERE id = ? AND gym_id = ?', [parsed.exercise_id, gymId]);
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id does not belong to this gym' });
    const { rowCount } = await db.query(
      `UPDATE workout_exercises SET
        exercise_id = ?, min_reps = ?, max_reps = ?, sets = ?, rest_seconds = ?, tempo = ?, notes = ?,
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND workout_block_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [parsed.exercise_id, parsed.min_reps, parsed.max_reps, parsed.sets, parsed.rest_seconds, parsed.tempo, parsed.notes,
       gymMembershipId, exId, blockId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Exercise item not found' });
    const { rows } = await db.query(
      'SELECT we.*, e.name AS exercise_name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.id = ?',
      [exId],
    );
    recordAudit(req, { action: 'update', entityType: 'workout_exercise', entityId: exId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlansRouter.delete('/:planId/workouts/:workoutId/blocks/:blockId/exercises/:exId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { blockId, exId } = req.params as { blockId: string; exId: string };
  const { rowCount } = await db.query(
    'UPDATE workout_exercises SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND workout_block_id = ? AND gym_id = ? AND deleted_at IS NULL',
    [exId, blockId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise item not found' });
  recordAudit(req, { action: 'delete', entityType: 'workout_exercise', entityId: exId });
  res.status(204).send();
});

/* ---- #67: cross-parent moves + duplicates (clone-side has no structural limits) ---- */

const COPY_NAME_LIMIT = 200;
const copyName = (name: string | null) => (name ? `${name} (copy)`.slice(0, COPY_NAME_LIMIT) : null);

// A block anywhere inside this plan (any workout) — validates move targets.
async function blockInPlan(blockId: string | number, planId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workout_blocks b JOIN workouts w ON w.id = b.workout_id
     WHERE b.id = ? AND w.training_plan_id = ? AND b.gym_id = ?
       AND b.deleted_at IS NULL AND w.deleted_at IS NULL`,
    [blockId, planId, gymId],
  );
  return rows.length > 0;
}

/**
 * Move a block to another workout of the same plan. Mirrors the #63
 * cross-template block move: park the block on a temporary high position
 * (the (workout_id, position) unique index would collide otherwise), then
 * recompact both workouts in one transaction. position is 1-based within the
 * target; omitted → append at the end.
 */
trainingPlansRouter.put('/:planId/workouts/:workoutId/blocks/:blockId/move', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId, planId, workoutId, blockId } = req.params as { memberId: string; planId: string; workoutId: string; blockId: string };
  const targetId = Number(req.body.target_workout_id);
  if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: 'target_workout_id is required' });
  if (String(targetId) === workoutId) return res.status(400).json({ error: 'target must differ from the current workout; use reorder instead' });
  const position = req.body.position == null ? null : Number(req.body.position);
  if (position !== null && (!Number.isInteger(position) || position < 1)) {
    return res.status(400).json({ error: 'position must be a positive integer' });
  }
  try {
    if (!(await planExists(planId, memberId, gymId))) return res.status(404).json({ error: 'Training plan not found' });
    if (!(await blockExists(blockId, workoutId, gymId))) return res.status(404).json({ error: 'Block not found' });
    if (!(await workoutExists(String(targetId), planId, gymId))) {
      return res.status(400).json({ error: 'target_workout_id must be a workout of this plan' });
    }
    await db.transaction(async (tx) => {
      const { rows: sourceRows } = await tx.query(
        'SELECT id FROM workout_blocks WHERE workout_id = ? AND deleted_at IS NULL AND id != ? ORDER BY position',
        [workoutId, blockId],
      );
      const { rows: targetRows } = await tx.query(
        'SELECT id FROM workout_blocks WHERE workout_id = ? AND deleted_at IS NULL ORDER BY position',
        [targetId],
      );
      const targetOrder = targetRows.map((r: { id: number }) => r.id);
      const insertAt = position === null ? targetOrder.length : Math.min(position - 1, targetOrder.length);
      targetOrder.splice(insertAt, 0, Number(blockId));
      await tx.query(
        `UPDATE workout_blocks SET workout_id = ?, position = position + 2000000,
                modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
         WHERE id = ?`,
        [targetId, gymMembershipId, blockId],
      );
      if (sourceRows.length > 0) {
        await reorder(tx, 'workout_blocks', 'workout_id', workoutId, sourceRows.map((r: { id: number }) => r.id));
      }
      await reorder(tx, 'workout_blocks', 'workout_id', String(targetId), targetOrder);
    });
    const { rows } = await db.query('SELECT * FROM workout_blocks WHERE id = ?', [blockId]);
    recordAudit(req, { action: 'update', entityType: 'workout_block', entityId: blockId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Move an exercise item to another block of the same plan. Same park-then-recompact shape.
trainingPlansRouter.put('/:planId/workouts/:workoutId/blocks/:blockId/exercises/:exId/move', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId, planId, workoutId, blockId, exId } = req.params as
    { memberId: string; planId: string; workoutId: string; blockId: string; exId: string };
  const targetId = Number(req.body.target_block_id);
  if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: 'target_block_id is required' });
  if (String(targetId) === blockId) return res.status(400).json({ error: 'target must differ from the current block; use reorder instead' });
  const position = req.body.position == null ? null : Number(req.body.position);
  if (position !== null && (!Number.isInteger(position) || position < 1)) {
    return res.status(400).json({ error: 'position must be a positive integer' });
  }
  try {
    if (!(await planExists(planId, memberId, gymId))) return res.status(404).json({ error: 'Training plan not found' });
    if (!(await blockExists(blockId, workoutId, gymId))) return res.status(404).json({ error: 'Block not found' });
    const { rows: exRows } = await db.query(
      'SELECT 1 FROM workout_exercises WHERE id = ? AND workout_block_id = ? AND gym_id = ? AND deleted_at IS NULL',
      [exId, blockId, gymId],
    );
    if (exRows.length === 0) return res.status(404).json({ error: 'Exercise item not found' });
    if (!(await blockInPlan(targetId, planId, gymId))) {
      return res.status(400).json({ error: 'target_block_id must be a block of this plan' });
    }
    await db.transaction(async (tx) => {
      const { rows: sourceRows } = await tx.query(
        'SELECT id FROM workout_exercises WHERE workout_block_id = ? AND deleted_at IS NULL AND id != ? ORDER BY position',
        [blockId, exId],
      );
      const { rows: targetRows } = await tx.query(
        'SELECT id FROM workout_exercises WHERE workout_block_id = ? AND deleted_at IS NULL ORDER BY position',
        [targetId],
      );
      const targetOrder = targetRows.map((r: { id: number }) => r.id);
      const insertAt = position === null ? targetOrder.length : Math.min(position - 1, targetOrder.length);
      targetOrder.splice(insertAt, 0, Number(exId));
      await tx.query(
        `UPDATE workout_exercises SET workout_block_id = ?, position = position + 2000000,
                modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
         WHERE id = ?`,
        [targetId, gymMembershipId, exId],
      );
      if (sourceRows.length > 0) {
        await reorder(tx, 'workout_exercises', 'workout_block_id', blockId, sourceRows.map((r: { id: number }) => r.id));
      }
      await reorder(tx, 'workout_exercises', 'workout_block_id', String(targetId), targetOrder);
    });
    const { rows } = await db.query(
      'SELECT we.*, e.name AS exercise_name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.id = ?',
      [exId],
    );
    recordAudit(req, { action: 'update', entityType: 'workout_exercise', entityId: exId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Duplicate a workout (with its blocks and exercises) at the end of the plan.
trainingPlansRouter.post('/:planId/workouts/:workoutId/duplicate', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId, planId, workoutId } = req.params as { memberId: string; planId: string; workoutId: string };
  try {
    if (!(await planExists(planId, memberId, gymId))) return res.status(404).json({ error: 'Training plan not found' });
    const { rows: sourceRows } = await db.query(
      'SELECT * FROM workouts WHERE id = ? AND training_plan_id = ? AND gym_id = ? AND deleted_at IS NULL',
      [workoutId, planId, gymId],
    );
    if (sourceRows.length === 0) return res.status(404).json({ error: 'Workout not found' });
    const source = sourceRows[0];

    const newWorkoutId = await db.transaction(async (tx) => {
      const { rows: posRows } = await tx.query(
        'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workouts WHERE training_plan_id = ?',
        [planId],
      );
      const { insertId: copyId } = await tx.query(
        'INSERT INTO workouts (gym_id, training_plan_id, name, description, position, scheduled_weekday) VALUES (?, ?, ?, ?, ?, ?)',
        [gymId, planId, copyName(source.name), source.description, posRows[0].next_position, source.scheduled_weekday],
      );
      const { rows: blockRows } = await tx.query(
        'SELECT * FROM workout_blocks WHERE workout_id = ? AND deleted_at IS NULL ORDER BY position ASC',
        [workoutId],
      );
      for (const block of blockRows) {
        const { insertId: newBlockId } = await tx.query(
          `INSERT INTO workout_blocks
            (gym_id, workout_id, position, name, description, type, result_type,
             rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, copyId, block.position, block.name, block.description, block.type, block.result_type,
           block.rounds, block.duration_seconds, block.work_seconds, block.rest_seconds, block.is_optional, block.notes,
           gymMembershipId],
        );
        await tx.query(
          `INSERT INTO workout_exercises
            (gym_id, workout_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, modified_by_membership_id)
           SELECT gym_id, ?, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, ?
           FROM workout_exercises WHERE workout_block_id = ? AND deleted_at IS NULL`,
          [newBlockId, gymMembershipId, block.id],
        );
      }
      return copyId;
    });

    const { rows } = await db.query('SELECT * FROM workouts WHERE id = ?', [newWorkoutId]);
    recordAudit(req, { action: 'create', entityType: 'workout', entityId: newWorkoutId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Duplicate a block (with its exercises) at the end of the same workout.
trainingPlansRouter.post('/:planId/workouts/:workoutId/blocks/:blockId/duplicate', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { planId, workoutId, blockId } = req.params as { planId: string; workoutId: string; blockId: string };
  try {
    if (!(await workoutExists(workoutId, planId, gymId))) return res.status(404).json({ error: 'Workout not found' });
    const { rows: sourceRows } = await db.query(
      'SELECT * FROM workout_blocks WHERE id = ? AND workout_id = ? AND gym_id = ? AND deleted_at IS NULL',
      [blockId, workoutId, gymId],
    );
    if (sourceRows.length === 0) return res.status(404).json({ error: 'Block not found' });
    const source = sourceRows[0];

    const newBlockId = await db.transaction(async (tx) => {
      const { rows: posRows } = await tx.query(
        'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_blocks WHERE workout_id = ?',
        [workoutId],
      );
      const { insertId: copyId } = await tx.query(
        `INSERT INTO workout_blocks
          (gym_id, workout_id, position, name, description, type, result_type,
           rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, workoutId, posRows[0].next_position, copyName(source.name), source.description, source.type, source.result_type,
         source.rounds, source.duration_seconds, source.work_seconds, source.rest_seconds, source.is_optional, source.notes,
         gymMembershipId],
      );
      await tx.query(
        `INSERT INTO workout_exercises
          (gym_id, workout_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, modified_by_membership_id)
         SELECT gym_id, ?, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, ?
         FROM workout_exercises WHERE workout_block_id = ? AND deleted_at IS NULL`,
        [copyId, gymMembershipId, blockId],
      );
      return copyId;
    });

    const { rows } = await db.query('SELECT * FROM workout_blocks WHERE id = ?', [newBlockId]);
    recordAudit(req, { action: 'create', entityType: 'workout_block', entityId: newBlockId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// #112: Complete a plan — sets status=completed and stamps end_date.
trainingPlansRouter.post('/:planId/complete', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  const endDate = req.body.end_date ?? null;
  if (endDate != null && !(typeof endDate === 'string' && DATE_RE.test(endDate))) {
    return res.status(400).json({ error: 'end_date must be YYYY-MM-DD' });
  }
  try {
    const { rows: planRows } = await db.query(
      "SELECT status FROM training_plans WHERE id = ? AND member_id = ? AND gym_id = ? AND status != 'deleted'",
      [planId, memberId, gymId],
    );
    if (planRows.length === 0) return res.status(404).json({ error: 'Training plan not found' });
    if (planRows[0].status === 'completed') return res.status(400).json({ error: 'Training plan is already completed' });
    const resolvedEndDate = endDate ?? new Date().toISOString().slice(0, 10);
    await db.query(
      `UPDATE training_plans SET status = 'completed', end_date = ?,
              modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND member_id = ? AND gym_id = ?`,
      [resolvedEndDate, gymMembershipId, planId, memberId, gymId],
    );
    const { rows } = await db.query(`${PLAN_TREE_SELECT} WHERE tp.id = ?`, [planId]);
    recordAudit(req, { action: 'status_change', entityType: 'training_plan', entityId: planId,
      previous: { status: planRows[0].status }, next: { status: 'completed', end_date: resolvedEndDate } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// #112: Duplicate a training plan (all workouts, blocks, exercises) into a new draft plan.
trainingPlansRouter.post('/:planId/duplicate', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId, planId } = req.params as { memberId: string; planId: string };
  try {
    const { rows: planRows } = await db.query(
      `${PLAN_TREE_SELECT} WHERE tp.id = ? AND tp.member_id = ? AND tp.gym_id = ? AND tp.status != 'deleted'`,
      [planId, memberId, gymId],
    );
    if (planRows.length === 0) return res.status(404).json({ error: 'Training plan not found' });
    const src = planRows[0];

    const newPlanId = await db.transaction(async (tx) => {
      const { insertId: newId } = await tx.query(
        `INSERT INTO training_plans (gym_id, member_id, template_id, name, description, status, start_date, assigned_by_membership_id)
         VALUES (?, ?, ?, ?, ?, 'draft', CURRENT_DATE(), ?)`,
        [gymId, memberId, src.template_id, `${src.name} (copy)`, src.description, gymMembershipId],
      );
      for (const w of src.workouts ?? []) {
        const { insertId: wId } = await tx.query(
          'INSERT INTO workouts (gym_id, training_plan_id, name, description, position, scheduled_weekday) VALUES (?, ?, ?, ?, ?, ?)',
          [gymId, newId, w.name, w.description, w.position, w.scheduled_weekday],
        );
        for (const b of w.blocks ?? []) {
          const { insertId: bId } = await tx.query(
            `INSERT INTO workout_blocks
              (gym_id, workout_id, position, name, description, type, result_type,
               rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [gymId, wId, b.position, b.name, b.description, b.type, b.result_type,
             b.rounds, b.duration_seconds, b.work_seconds, b.rest_seconds, b.is_optional, b.notes, gymMembershipId],
          );
          for (const ex of b.exercises ?? []) {
            await tx.query(
              `INSERT INTO workout_exercises
                (gym_id, workout_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, modified_by_membership_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [gymId, bId, ex.exercise_id, ex.position, ex.min_reps, ex.max_reps, ex.sets,
               ex.rest_seconds, ex.tempo, ex.notes, gymMembershipId],
            );
          }
        }
      }
      return newId;
    });
    const { rows } = await db.query(`${PLAN_TREE_SELECT} WHERE tp.id = ?`, [newPlanId]);
    recordAudit(req, { action: 'create', entityType: 'training_plan', entityId: newPlanId,
      next: { duplicated_from: planId, member_id: memberId } });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Duplicate an exercise item at the end of the same block.
trainingPlansRouter.post('/:planId/workouts/:workoutId/blocks/:blockId/exercises/:exId/duplicate', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { workoutId, blockId, exId } = req.params as { workoutId: string; blockId: string; exId: string };
  try {
    if (!(await blockExists(blockId, workoutId, gymId))) return res.status(404).json({ error: 'Block not found' });
    const { insertId } = await db.query(
      `INSERT INTO workout_exercises
        (gym_id, workout_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo, notes, modified_by_membership_id)
       SELECT we.gym_id, we.workout_block_id, we.exercise_id,
              (SELECT COALESCE(MAX(position), 0) + 1 FROM workout_exercises WHERE workout_block_id = ?),
              we.min_reps, we.max_reps, we.sets, we.rest_seconds, we.tempo, we.notes, ?
       FROM workout_exercises we
       WHERE we.id = ? AND we.workout_block_id = ? AND we.gym_id = ? AND we.deleted_at IS NULL`,
      [blockId, gymMembershipId, exId, blockId, gymId],
    );
    if (!insertId) return res.status(404).json({ error: 'Exercise item not found' });
    const { rows } = await db.query(
      'SELECT we.*, e.name AS exercise_name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.id = ?',
      [insertId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

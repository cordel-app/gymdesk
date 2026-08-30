import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';

export const platformWorkoutTemplatesRouter = Router();

const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];
const BLOCK_TYPE_MAX_EXERCISES: Record<string, number | null> = {
  Standard: 1, Superset: 2, Triset: 3,
  GiantSet: null, Circuit: null, EMOM: null, AMRAP: null, Tabata: null,
};
const SETTABLE_STATUSES = ['active', 'inactive'];

async function templateExists(id: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM workout_templates WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL',
    [id],
  );
  return rows.length > 0;
}

async function blockExists(blockId: string, templateId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM workout_template_blocks WHERE id = ? AND workout_template_id = ? AND gym_id IS NULL AND deleted_at IS NULL',
    [blockId, templateId],
  );
  return rows.length > 0;
}

function parseBlockBody(body: Record<string, unknown>):
  | { name: string | null; description: string | null; type: string;
      rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
      is_optional: boolean; notes: string | null }
  | string
{
  const type = body.type as string | undefined;
  if (!type || !BLOCK_TYPES.includes(type)) return `type must be one of: ${BLOCK_TYPES.join(', ')}`;
  const toIntOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const name = body.name as string | null | undefined;
  const description = body.description as string | null | undefined;
  const notes = body.notes as string | null | undefined;
  return {
    name: name?.trim() || null,
    description: description ?? null,
    type,
    rounds: toIntOrNull(body.rounds),
    duration_seconds: toIntOrNull(body.duration_seconds),
    work_seconds: toIntOrNull(body.work_seconds),
    rest_seconds: toIntOrNull(body.rest_seconds),
    is_optional: Boolean(body.is_optional),
    notes: notes ?? null,
  };
}

function parseExerciseItemBody(body: Record<string, unknown>):
  | { exercise_id: number; min_reps: number | null; max_reps: number | null; sets: number | null;
      rest_seconds: number | null; tempo: string | null;
      result_type_id: number | null; target_value: number | null; min_value: number | null;
      max_value: number | null; unit: string | null }
  | string
{
  const exerciseId = Number(body.exercise_id);
  if (!Number.isInteger(exerciseId) || exerciseId <= 0) return 'exercise_id is required';
  const toIntOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const toFloatOrNull = (v: unknown) => (v == null || v === '' ? null : parseFloat(String(v)));
  const tempo = body.tempo as string | null | undefined;
  const unit = body.unit as string | null | undefined;
  return {
    exercise_id: exerciseId,
    min_reps: toIntOrNull(body.min_reps),
    max_reps: toIntOrNull(body.max_reps),
    sets: toIntOrNull(body.sets),
    rest_seconds: toIntOrNull(body.rest_seconds),
    tempo: tempo?.trim() || null,
    result_type_id: toIntOrNull(body.result_type_id),
    target_value: toFloatOrNull(body.target_value),
    min_value: toFloatOrNull(body.min_value),
    max_value: toFloatOrNull(body.max_value),
    unit: unit?.trim() || null,
  };
}

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

/* ── WorkoutTemplate ─────────────────────────────────────────────────────── */

platformWorkoutTemplatesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 100;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const where: string[] = ['wt.gym_id IS NULL', 'wt.deleted_at IS NULL'];
    const params: any[] = [];
    if (status) { where.push('wt.status = ?'); params.push(status); }
    if (name) { where.push('wt.name LIKE ?'); params.push(`%${name}%`); }
    const whereSql = where.join(' AND ');
    const { rows: countRows } = await db.query(`SELECT COUNT(*) AS total FROM workout_templates wt WHERE ${whereSql}`, params);
    const { rows } = await db.query(
      `SELECT wt.*,
              (SELECT COUNT(*) FROM workout_template_blocks wtb
               WHERE wtb.workout_template_id = wt.id AND wtb.deleted_at IS NULL) AS blocks_count
       FROM workout_templates wt
       WHERE ${whereSql}
       ORDER BY wt.name ASC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      `SELECT wt.*,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', b.id, 'position', b.position, 'name', b.name, 'description', b.description,
              'type', b.type, 'rounds', b.rounds,
              'duration_seconds', b.duration_seconds, 'work_seconds', b.work_seconds, 'rest_seconds', b.rest_seconds,
              'is_optional', b.is_optional, 'notes', b.notes,
              'exercises', (SELECT JSON_ARRAYAGG(item) FROM (
                SELECT JSON_OBJECT(
                    'id', wte.id, 'position', wte.position, 'exercise_id', wte.exercise_id,
                    'exercise_name', e.name,
                    'min_reps', wte.min_reps, 'max_reps', wte.max_reps,
                    'sets', wte.sets, 'rest_seconds', wte.rest_seconds, 'tempo', wte.tempo,
                    'result_type_id', wte.result_type_id, 'result_type_slug', rt.slug, 'result_type_name', rt.name,
                    'target_value', wte.target_value, 'min_value', wte.min_value, 'max_value', wte.max_value,
                    'unit', wte.unit) AS item
                FROM workout_template_exercises wte
                JOIN exercises e ON e.id = wte.exercise_id
                LEFT JOIN result_types rt ON rt.id = wte.result_type_id
                WHERE wte.workout_template_block_id = b.id AND wte.deleted_at IS NULL
                ORDER BY wte.position
              ) t2)
            ) AS item
          FROM workout_template_blocks b WHERE b.workout_template_id = wt.id AND b.deleted_at IS NULL
          ORDER BY b.position
        ) t1) AS blocks
       FROM workout_templates wt
       WHERE wt.id = ? AND wt.gym_id IS NULL AND wt.deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workout template not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, description, status, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  try {
    const row = await insertAndFetch(
      `INSERT INTO workout_templates
        (gym_id, name, description, status, notes, modified_at)
       VALUES (NULL, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [name.trim(), description ?? null, status ?? 'active', notes ?? null],
      'SELECT * FROM workout_templates WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  const { name, description, status, notes } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE workout_templates
          SET name = COALESCE(?, name),
              description = IF(?, ?, description),
              status = COALESCE(?, status),
              notes = IF(?, ?, notes),
              modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL`,
      [name?.trim() ?? null,
       'description' in req.body ? 1 : 0, description ?? null,
       status ?? null,
       'notes' in req.body ? 1 : 0, notes ?? null,
       id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Workout template not found' });
    const { rows } = await db.query('SELECT * FROM workout_templates WHERE id = ?', [id]);
    recordAudit(req, { action: 'update', entityType: 'workout_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    const { rowCount } = await db.query(
      "UPDATE workout_templates SET deleted_at = UTC_TIMESTAMP(), status = 'deleted' WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL",
      [id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Workout template not found' });
    recordAudit(req, { action: 'delete', entityType: 'workout_template', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── WorkoutTemplateBlock ────────────────────────────────────────────────── */

platformWorkoutTemplatesRouter.get('/:id/blocks', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id))) return res.status(404).json({ error: 'Workout template not found' });
    const { rows } = await db.query(
      'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND gym_id IS NULL AND deleted_at IS NULL ORDER BY position ASC',
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.post('/:id/blocks', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await templateExists(id))) return res.status(404).json({ error: 'Workout template not found' });
  const parsed = parseBlockBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_template_blocks WHERE workout_template_id = ?',
      [id],
    );
    const row = await insertAndFetch(
      `INSERT INTO workout_template_blocks
        (gym_id, workout_template_id, position, name, description, type,
         rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, posRows[0].next_position, parsed.name, parsed.description, parsed.type,
       parsed.rounds, parsed.duration_seconds, parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes],
      'SELECT * FROM workout_template_blocks WHERE id = ?',
      (blockId) => [blockId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template_block', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.put('/:id/blocks/reorder', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await templateExists(id))) return res.status(404).json({ error: 'Workout template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of block ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workout_template_blocks', 'workout_template_id', id, order));
    const { rows } = await db.query(
      'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND gym_id IS NULL AND deleted_at IS NULL ORDER BY position ASC',
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.put('/:id/blocks/:blockId', requireSuperadmin, async (req, res, next) => {
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await templateExists(id))) return res.status(404).json({ error: 'Workout template not found' });
  const parsed = parseBlockBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const maxEx = BLOCK_TYPE_MAX_EXERCISES[parsed.type];
    if (maxEx !== null) {
      const { rows: countRows } = await db.query(
        'SELECT COUNT(*) AS ex_count FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL',
        [blockId],
      );
      if (countRows[0].ex_count > maxEx) {
        return res.status(422).json({
          error: 'MaximumExercisesExceeded',
          message: `Block type '${parsed.type}' allows a maximum of ${maxEx} exercises. Remove exercises first.`,
        });
      }
    }
    const { rowCount } = await db.query(
      `UPDATE workout_template_blocks SET
        name = ?, description = ?, type = ?, rounds = ?, duration_seconds = ?,
        work_seconds = ?, rest_seconds = ?, is_optional = ?, notes = ?,
        modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND workout_template_id = ? AND gym_id IS NULL AND deleted_at IS NULL`,
      [parsed.name, parsed.description, parsed.type, parsed.rounds, parsed.duration_seconds,
       parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes,
       blockId, id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Block not found' });
    const { rows } = await db.query('SELECT * FROM workout_template_blocks WHERE id = ?', [blockId]);
    recordAudit(req, { action: 'update', entityType: 'workout_template_block', entityId: blockId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.delete('/:id/blocks/:blockId', requireSuperadmin, async (req, res, next) => {
  const { id, blockId } = req.params as { id: string; blockId: string };
  try {
    const { rowCount } = await db.query(
      'UPDATE workout_template_blocks SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND workout_template_id = ? AND gym_id IS NULL AND deleted_at IS NULL',
      [blockId, id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Block not found' });
    recordAudit(req, { action: 'delete', entityType: 'workout_template_block', entityId: blockId });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── WorkoutTemplateExercise ─────────────────────────────────────────────── */

platformWorkoutTemplatesRouter.get('/:id/blocks/:blockId/exercises', requireSuperadmin, async (req, res, next) => {
  const { id, blockId } = req.params as { id: string; blockId: string };
  try {
    if (!(await blockExists(blockId, id))) return res.status(404).json({ error: 'Block not found' });
    const { rows } = await db.query(
      `SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte
       JOIN exercises e ON e.id = wte.exercise_id
       WHERE wte.workout_template_block_id = ? AND wte.gym_id IS NULL AND wte.deleted_at IS NULL
       ORDER BY wte.position ASC`,
      [blockId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.post('/:id/blocks/:blockId/exercises', requireSuperadmin, async (req, res, next) => {
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await blockExists(blockId, id))) return res.status(404).json({ error: 'Block not found' });
  const parsed = parseExerciseItemBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: blockRows } = await db.query(
      `SELECT b.type, COUNT(wte.id) AS ex_count
       FROM workout_template_blocks b
       LEFT JOIN workout_template_exercises wte ON wte.workout_template_block_id = b.id AND wte.deleted_at IS NULL
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
    // Base exercises only (gym_id IS NULL) can be linked to base templates
    const { rows: exRows } = await db.query(
      'SELECT 1 FROM exercises WHERE id = ? AND gym_id IS NULL AND status != \'deleted\'',
      [parsed.exercise_id],
    );
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id is not a base exercise' });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_template_exercises WHERE workout_template_block_id = ?',
      [blockId],
    );
    const row = await insertAndFetch(
      `INSERT INTO workout_template_exercises
        (gym_id, workout_template_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo,
         result_type_id, target_value, min_value, max_value, unit)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [blockId, parsed.exercise_id, posRows[0].next_position, parsed.min_reps, parsed.max_reps,
       parsed.sets, parsed.rest_seconds, parsed.tempo,
       parsed.result_type_id, parsed.target_value, parsed.min_value, parsed.max_value, parsed.unit],
      'SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id WHERE wte.id = ?',
      (exId) => [exId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template_exercise', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.put('/:id/blocks/:blockId/exercises/reorder', requireSuperadmin, async (req, res, next) => {
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await blockExists(blockId, id))) return res.status(404).json({ error: 'Block not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of exercise-item ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'workout_template_exercises', 'workout_template_block_id', blockId, order));
    const { rows } = await db.query(
      'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND gym_id IS NULL AND deleted_at IS NULL ORDER BY position ASC',
      [blockId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.put('/:id/blocks/:blockId/exercises/:exId', requireSuperadmin, async (req, res, next) => {
  const { id, blockId, exId } = req.params as { id: string; blockId: string; exId: string };
  if (!(await blockExists(blockId, id))) return res.status(404).json({ error: 'Block not found' });
  const parsed = parseExerciseItemBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    const { rows: exRows } = await db.query(
      "SELECT 1 FROM exercises WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [parsed.exercise_id],
    );
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id is not a base exercise' });
    const { rowCount } = await db.query(
      `UPDATE workout_template_exercises SET
        exercise_id = ?, min_reps = ?, max_reps = ?, sets = ?, rest_seconds = ?, tempo = ?,
        result_type_id = ?, target_value = ?, min_value = ?, max_value = ?, unit = ?,
        modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND workout_template_block_id = ? AND gym_id IS NULL AND deleted_at IS NULL`,
      [parsed.exercise_id, parsed.min_reps, parsed.max_reps, parsed.sets, parsed.rest_seconds, parsed.tempo,
       parsed.result_type_id, parsed.target_value, parsed.min_value, parsed.max_value, parsed.unit,
       exId, blockId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Exercise item not found' });
    const { rows } = await db.query(
      'SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id WHERE wte.id = ?',
      [exId],
    );
    recordAudit(req, { action: 'update', entityType: 'workout_template_exercise', entityId: exId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformWorkoutTemplatesRouter.delete('/:id/blocks/:blockId/exercises/:exId', requireSuperadmin, async (req, res, next) => {
  const { blockId, exId } = req.params as { id: string; blockId: string; exId: string };
  try {
    const { rowCount } = await db.query(
      'UPDATE workout_template_exercises SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND workout_template_block_id = ? AND gym_id IS NULL AND deleted_at IS NULL',
      [exId, blockId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise item not found' });
    recordAudit(req, { action: 'delete', entityType: 'workout_template_exercise', entityId: exId });
    res.status(204).send();
  } catch (err) { next(err); }
});

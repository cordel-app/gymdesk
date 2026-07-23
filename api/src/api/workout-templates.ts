import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { getReferences } from '../domain/references';
import { insertAndFetch } from '../infra/db-helpers';

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
// null = unlimited
const BLOCK_TYPE_MAX_EXERCISES: Record<string, number | null> = {
  Standard: 1, Superset: 2, Triset: 3,
  GiantSet: null, Circuit: null, EMOM: null, AMRAP: null, Tabata: null,
};
const SETTABLE_STATUSES = ['active', 'inactive'];

// GET / list sorting: map the public sort key to a safe column (never interpolate raw input).
const SORT_COLUMNS: Record<string, string> = {
  name: 'wt.name',
  created_at: 'wt.created_at',
  status: 'wt.status',
};
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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

function parseBlockBody(body: Record<string, unknown>):
  | { name: string | null; description: string | null; type: string;
      rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
      is_optional: boolean; notes: string | null }
  | string
{
  const name = body.name as string | null | undefined;
  const description = body.description as string | null | undefined;
  const type = body.type as string | undefined;
  const notes = body.notes as string | null | undefined;
  if (!type || !BLOCK_TYPES.includes(type)) return `type must be one of: ${BLOCK_TYPES.join(', ')}`;
  const toIntOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
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

/* ---- WorkoutTemplate ---- */

/**
 * #63: with limit/offset the response is the paginated { items, total, limit,
 * offset } shape with name/created_by/status filters and sorting (mirrors
 * GET /training-plan-templates). Without them it stays the legacy plain array
 * ordered by name — the Training Plan editor's workout selector depends on it.
 */
workoutTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const createdBy = req.query.created_by == null || req.query.created_by === ''
    ? null : Number(req.query.created_by);
  if (createdBy !== null && !Number.isInteger(createdBy)) {
    return res.status(400).json({ error: 'created_by must be a membership id' });
  }
  const paginated = req.query.limit !== undefined || req.query.offset !== undefined;
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS ? req.query.sort : 'name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  // limit/offset are validated integers — interpolated because mysql2 prepared
  // statements don't accept placeholders in LIMIT reliably.
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const where: string[] = ['wt.gym_id = ?', 'wt.deleted_at IS NULL'];
    const params: (string | number)[] = [gymId];
    if (status) { where.push('wt.status = ?'); params.push(status); }
    if (name) { where.push('wt.name LIKE ?'); params.push(`%${name}%`); }
    if (createdBy !== null) { where.push('wt.created_by_membership_id = ?'); params.push(createdBy); }
    const whereSql = where.join(' AND ');

    if (!paginated) {
      const { rows } = await db.query(
        `SELECT wt.* FROM workout_templates wt WHERE ${whereSql} ORDER BY wt.name ASC`,
        params,
      );
      return res.json(rows);
    }

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM workout_templates wt WHERE ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT wt.*, gm.name AS created_by_name
       FROM workout_templates wt
       LEFT JOIN gym_memberships gm ON gm.id = wt.created_by_membership_id
       WHERE ${whereSql}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err) {
    next(err);
  }
});

// Distinct authors of this gym's non-deleted templates — populates the Created By filter.
workoutTemplatesRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT gm.id AS membership_id, gm.name
       FROM workout_templates wt
       JOIN gym_memberships gm ON gm.id = wt.created_by_membership_id
       WHERE wt.gym_id = ? AND wt.deleted_at IS NULL AND gm.name IS NOT NULL
       ORDER BY gm.name ASC`,
      [gymId],
    );
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
       FROM workout_templates wt WHERE wt.id = ? AND wt.gym_id = ? AND wt.deleted_at IS NULL`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workout template not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  try {
    const row = await insertAndFetch(
      'INSERT INTO workout_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
      [gymId, name.trim(), description ?? null, status ?? 'active', gymMembershipId],
      'SELECT * FROM workout_templates WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
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

workoutTemplatesRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
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

workoutTemplatesRouter.post('/:id/duplicate', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows: srcRows } = await db.query(
      'SELECT * FROM workout_templates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Workout template not found' });
    const src = srcRows[0];

    let copyName = `${src.name} (Copy)`;
    const { rows: existing } = await db.query(
      'SELECT name FROM workout_templates WHERE gym_id = ? AND name LIKE ? AND deleted_at IS NULL',
      [gymId, `${src.name} (Copy%`],
    );
    if (existing.length > 0) {
      copyName = `${src.name} (Copy ${existing.length + 1})`;
    }

    await db.transaction(async (tx) => {
      const { insertId: newId } = await tx.query(
        'INSERT INTO workout_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
        [gymId, copyName, src.description ?? null, src.status, gymMembershipId],
      );

      const { rows: blocks } = await tx.query(
        'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND deleted_at IS NULL ORDER BY position ASC',
        [id],
      );
      for (const block of blocks) {
        const { insertId: newBlockId } = await tx.query(
          `INSERT INTO workout_template_blocks
            (gym_id, workout_template_id, position, name, description, type,
             rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, newId, block.position, block.name, block.description, block.type,
           block.rounds, block.duration_seconds, block.work_seconds, block.rest_seconds, block.is_optional, block.notes],
        );

        const { rows: exercises } = await tx.query(
          'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL ORDER BY position ASC',
          [block.id],
        );
        for (const ex of exercises) {
          await tx.query(
            `INSERT INTO workout_template_exercises
              (gym_id, workout_template_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo,
               result_type_id, target_value, min_value, max_value, unit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [gymId, newBlockId, ex.exercise_id, ex.position, ex.min_reps, ex.max_reps, ex.sets, ex.rest_seconds, ex.tempo,
             ex.result_type_id ?? null, ex.target_value ?? null, ex.min_value ?? null, ex.max_value ?? null, ex.unit ?? null],
          );
        }
      }

      const { rows: newRows } = await tx.query('SELECT * FROM workout_templates WHERE id = ?', [newId]);
      recordAudit(req, { action: 'create', entityType: 'workout_template', entityId: newId, next: newRows[0] });
      res.status(201).json(newRows[0]);
    });
  } catch (err) {
    next(err);
  }
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

workoutTemplatesRouter.post('/:id/blocks', requireModuleWrite('TRAINING'), async (req, res, next) => {
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
    const row = await insertAndFetch(
      `INSERT INTO workout_template_blocks
        (gym_id, workout_template_id, position, name, description, type,
         rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, id, posRows[0].next_position, parsed.name, parsed.description, parsed.type,
       parsed.rounds, parsed.duration_seconds, parsed.work_seconds, parsed.rest_seconds, parsed.is_optional, parsed.notes,
       gymMembershipId],
      'SELECT * FROM workout_template_blocks WHERE id = ?',
      (blockId) => [blockId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template_block', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/reorder', requireModuleWrite('TRAINING'), async (req, res, next) => {
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

/**
 * #63: move a block to another workout template (tree-grid cross-template
 * drag-and-drop). Reparents the block and recompacts positions in both
 * templates in one transaction. position is 1-based within the target; omitted
 * → append at the end. Designed so future cross-parent moves (e.g. exercises)
 * can follow the same shape.
 */
workoutTemplatesRouter.put('/:id/blocks/:blockId/move', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  const targetId = Number(req.body.target_workout_template_id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'target_workout_template_id is required' });
  }
  if (String(targetId) === id) {
    return res.status(400).json({ error: 'target must differ from the current template; use reorder instead' });
  }
  const position = req.body.position == null ? null : Number(req.body.position);
  if (position !== null && (!Number.isInteger(position) || position < 1)) {
    return res.status(400).json({ error: 'position must be a positive integer' });
  }
  try {
    if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
    if (!(await templateExists(String(targetId), gymId))) {
      return res.status(400).json({ error: 'target_workout_template_id does not belong to this gym' });
    }
    await db.transaction(async (tx) => {
      const { rows: sourceRows } = await tx.query(
        'SELECT id FROM workout_template_blocks WHERE workout_template_id = ? AND deleted_at IS NULL AND id != ? ORDER BY position',
        [id, blockId],
      );
      const { rows: targetRows } = await tx.query(
        'SELECT id FROM workout_template_blocks WHERE workout_template_id = ? AND deleted_at IS NULL ORDER BY position',
        [targetId],
      );
      const targetOrder = targetRows.map((r: { id: number }) => r.id);
      const insertAt = position === null ? targetOrder.length : Math.min(position - 1, targetOrder.length);
      targetOrder.splice(insertAt, 0, Number(blockId));
      // Park on a temporary high position first — (workout_template_id, position)
      // is unique, so landing directly on an occupied slot would collide.
      await tx.query(
        `UPDATE workout_template_blocks SET workout_template_id = ?, position = position + 2000000,
                modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
         WHERE id = ?`,
        [targetId, gymMembershipId, blockId],
      );
      if (sourceRows.length > 0) {
        await reorder(tx, 'workout_template_blocks', 'workout_template_id', id, sourceRows.map((r: { id: number }) => r.id));
      }
      await reorder(tx, 'workout_template_blocks', 'workout_template_id', String(targetId), targetOrder);
    });
    const { rows } = await db.query('SELECT * FROM workout_template_blocks WHERE id = ?', [blockId]);
    recordAudit(req, { action: 'update', entityType: 'workout_template_block', entityId: blockId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/:blockId', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Workout template not found' });
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
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND workout_template_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [parsed.name, parsed.description, parsed.type, parsed.rounds, parsed.duration_seconds,
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

workoutTemplatesRouter.post('/:id/blocks/:blockId/duplicate', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
  try {
    const { rows: srcRows } = await db.query(
      'SELECT * FROM workout_template_blocks WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [blockId, gymId],
    );
    const src = srcRows[0];
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM workout_template_blocks WHERE workout_template_id = ? AND deleted_at IS NULL',
      [id],
    );
    await db.transaction(async (tx) => {
      const { insertId: newBlockId } = await tx.query(
        `INSERT INTO workout_template_blocks
          (gym_id, workout_template_id, position, name, description, type,
           rounds, duration_seconds, work_seconds, rest_seconds, is_optional, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, id, posRows[0].next_pos, src.name, src.description, src.type,
         src.rounds, src.duration_seconds, src.work_seconds, src.rest_seconds, src.is_optional, src.notes],
      );
      const { rows: exercises } = await tx.query(
        'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL ORDER BY position ASC',
        [blockId],
      );
      for (const ex of exercises) {
        await tx.query(
          `INSERT INTO workout_template_exercises
            (gym_id, workout_template_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo,
             result_type_id, target_value, min_value, max_value, unit, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, newBlockId, ex.exercise_id, ex.position, ex.min_reps, ex.max_reps, ex.sets, ex.rest_seconds, ex.tempo,
           ex.result_type_id ?? null, ex.target_value ?? null, ex.min_value ?? null, ex.max_value ?? null, ex.unit ?? null, gymMembershipId],
        );
      }
      const { rows: newRows } = await tx.query('SELECT * FROM workout_template_blocks WHERE id = ?', [newBlockId]);
      recordAudit(req, { action: 'create', entityType: 'workout_template_block', entityId: newBlockId, next: newRows[0] });
      res.status(201).json(newRows[0]);
    });
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.delete('/:id/blocks/:blockId', requireModuleWrite('TRAINING'), async (req, res) => {
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

workoutTemplatesRouter.post('/:id/blocks/:blockId/exercises', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId } = req.params as { id: string; blockId: string };
  if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
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
    const { rows: exRows } = await db.query('SELECT 1 FROM exercises WHERE id = ? AND gym_id = ?', [parsed.exercise_id, gymId]);
    if (exRows.length === 0) return res.status(400).json({ error: 'exercise_id does not belong to this gym' });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_template_exercises WHERE workout_template_block_id = ?',
      [blockId],
    );
    const row = await insertAndFetch(
      `INSERT INTO workout_template_exercises
        (gym_id, workout_template_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo,
         result_type_id, target_value, min_value, max_value, unit, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, blockId, parsed.exercise_id, posRows[0].next_position, parsed.min_reps, parsed.max_reps,
       parsed.sets, parsed.rest_seconds, parsed.tempo,
       parsed.result_type_id, parsed.target_value, parsed.min_value, parsed.max_value, parsed.unit, gymMembershipId],
      'SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id WHERE wte.id = ?',
      (exId) => [exId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template_exercise', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.put('/:id/blocks/:blockId/exercises/reorder', requireModuleWrite('TRAINING'), async (req, res, next) => {
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

workoutTemplatesRouter.put('/:id/blocks/:blockId/exercises/:exId', requireModuleWrite('TRAINING'), async (req, res, next) => {
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
        result_type_id = ?, target_value = ?, min_value = ?, max_value = ?, unit = ?,
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND workout_template_block_id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [parsed.exercise_id, parsed.min_reps, parsed.max_reps, parsed.sets, parsed.rest_seconds, parsed.tempo,
       parsed.result_type_id, parsed.target_value, parsed.min_value, parsed.max_value, parsed.unit, gymMembershipId,
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

workoutTemplatesRouter.post('/:id/blocks/:blockId/exercises/:exId/duplicate', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id, blockId, exId } = req.params as { id: string; blockId: string; exId: string };
  if (!(await blockExists(blockId, id, gymId))) return res.status(404).json({ error: 'Block not found' });
  try {
    const { rows: srcRows } = await db.query(
      'SELECT * FROM workout_template_exercises WHERE id = ? AND workout_template_block_id = ? AND gym_id = ? AND deleted_at IS NULL',
      [exId, blockId, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Exercise item not found' });
    const src = srcRows[0];

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

    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL',
      [blockId],
    );
    const row = await insertAndFetch(
      `INSERT INTO workout_template_exercises
        (gym_id, workout_template_block_id, exercise_id, position, min_reps, max_reps, sets, rest_seconds, tempo,
         result_type_id, target_value, min_value, max_value, unit, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, blockId, src.exercise_id, posRows[0].next_position, src.min_reps, src.max_reps, src.sets, src.rest_seconds, src.tempo,
       src.result_type_id ?? null, src.target_value ?? null, src.min_value ?? null, src.max_value ?? null, src.unit ?? null, gymMembershipId],
      'SELECT wte.*, e.name AS exercise_name FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id WHERE wte.id = ?',
      (newId) => [newId],
    );
    recordAudit(req, { action: 'create', entityType: 'workout_template_exercise', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

workoutTemplatesRouter.delete('/:id/blocks/:blockId/exercises/:exId', requireModuleWrite('TRAINING'), async (req, res) => {
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

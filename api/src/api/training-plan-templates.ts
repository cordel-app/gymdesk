import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/**
 * #55: TrainingPlanTemplate (reusable multi-day program) + the ordered
 * training_plan_template_workouts junction to WorkoutTemplate. Cloned into
 * TrainingPlan (see training-plans.ts) on assignment (see member-training-plans.ts).
 */

export const trainingPlanTemplatesRouter = Router();

const STATUSES = ['active', 'inactive', 'draft', 'deleted'];

// GET / list sorting: map the public sort key to a safe column (never interpolate raw input).
const SORT_COLUMNS: Record<string, string> = {
  name: 'tpt.name',
  created_at: 'tpt.created_at',
  status: 'tpt.status',
};
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

async function templateExists(id: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM training_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [id, gymId],
  );
  return rows.length > 0;
}

/* ---- TrainingPlanTemplate ---- */

trainingPlanTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const createdBy = req.query.created_by == null || req.query.created_by === ''
    ? null : Number(req.query.created_by);
  if (createdBy !== null && !Number.isInteger(createdBy)) {
    return res.status(400).json({ error: 'created_by must be a membership id' });
  }
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS ? req.query.sort : 'name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  // limit/offset are validated integers — interpolated because mysql2 prepared
  // statements don't accept placeholders in LIMIT reliably.
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const where: string[] = ['tpt.gym_id = ?', "tpt.status != 'deleted'"];
    const params: any[] = [gymId];
    if (status) { where.push('tpt.status = ?'); params.push(status); }
    if (name) { where.push('tpt.name LIKE ?'); params.push(`%${name}%`); }
    if (createdBy !== null) { where.push('tpt.created_by_membership_id = ?'); params.push(createdBy); }
    const whereSql = where.join(' AND ');

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM training_plan_templates tpt WHERE ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT tpt.*,
              gm_c.name AS created_by_name,
              gm_m.name AS modified_by_name,
              gm_d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count
       FROM training_plan_templates tpt
       LEFT JOIN gym_memberships gm_c ON gm_c.id = tpt.created_by_membership_id
       LEFT JOIN gym_memberships gm_m ON gm_m.id = tpt.modified_by_membership_id
       LEFT JOIN gym_memberships gm_d ON gm_d.id = tpt.deleted_by_membership_id
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
trainingPlanTemplatesRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT gm.id AS membership_id, gm.name
       FROM training_plan_templates tpt
       JOIN gym_memberships gm ON gm.id = tpt.created_by_membership_id
       WHERE tpt.gym_id = ? AND tpt.status != 'deleted' AND gm.name IS NOT NULL
       ORDER BY gm.name ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    // MySQL's JSON_ARRAYAGG has no ORDER BY of its own — aggregate over a
    // derived table pre-sorted by position instead.
    const { rows } = await db.query(
      `SELECT tpt.*, gm.name AS created_by_name,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', j.id, 'position', j.position, 'scheduled_weekday', j.scheduled_weekday,
              'workout_template_id', j.workout_template_id, 'workout_template_name', wt.name) AS item
          FROM training_plan_template_workouts j JOIN workout_templates wt ON wt.id = j.workout_template_id
          WHERE j.training_plan_template_id = tpt.id
          ORDER BY j.position
        ) t1) AS workouts
       FROM training_plan_templates tpt
       LEFT JOIN gym_memberships gm ON gm.id = tpt.created_by_membership_id
       WHERE tpt.id = ? AND tpt.gym_id = ? AND tpt.status != 'deleted'`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Full 4-level tree (workouts -> blocks -> exercises) for one template, in a
// single request — the client fetches this on first expand of a template row
// and caches it. Extends the derived-table-per-level JSON_ARRAYAGG pattern used
// by GET /:id here and by workout-templates.ts GET /:id one level deeper.
trainingPlanTemplatesRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      `SELECT tpt.id, tpt.name, tpt.status,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', j.id, 'position', j.position, 'scheduled_weekday', j.scheduled_weekday,
              'workout_template_id', j.workout_template_id, 'workout_template_name', wt.name,
              'blocks', (SELECT JSON_ARRAYAGG(item) FROM (
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
                    ) t3)
                  ) AS item
                FROM workout_template_blocks b WHERE b.workout_template_id = wt.id AND b.deleted_at IS NULL
                ORDER BY b.position
              ) t2)
            ) AS item
          FROM training_plan_template_workouts j JOIN workout_templates wt ON wt.id = j.workout_template_id
          WHERE j.training_plan_template_id = tpt.id
          ORDER BY j.position
        ) t1) AS workouts
       FROM training_plan_templates tpt WHERE tpt.id = ? AND tpt.gym_id = ? AND tpt.status != 'deleted'`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { insertId } = await db.query(
      'INSERT INTO training_plan_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
      [gymId, name.trim(), description ?? null, status ?? 'active', gymMembershipId],
    );
    const { rows } = await db.query('SELECT * FROM training_plan_templates WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A template with this name already exists.' });
    next(err);
  }
});

trainingPlanTemplatesRouter.put('/:id', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_templates SET
        name = COALESCE(?, name), description = IF(?, ?, description), status = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null, gymMembershipId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Training plan template not found' });
    const { rows } = await db.query('SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ?', [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'training_plan_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A template with this name already exists.' });
    next(err);
  }
});

trainingPlanTemplatesRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { rowCount } = await db.query(
    "UPDATE training_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [gymMembershipId, id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Training plan template not found' });
  recordAudit(req, { action: 'delete', entityType: 'training_plan_template', entityId: id });
  res.status(204).send();
});

trainingPlanTemplatesRouter.post('/:id/duplicate', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows: srcRows } = await db.query(
      "SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    const src = srcRows[0];

    let copyName = `${src.name} (Copy)`;
    // Avoid unique-name conflicts by appending a suffix when needed.
    const { rows: existing } = await db.query(
      'SELECT name FROM training_plan_templates WHERE gym_id = ? AND name LIKE ?',
      [gymId, `${src.name} (Copy%`],
    );
    if (existing.length > 0) {
      copyName = `${src.name} (Copy ${existing.length + 1})`;
    }

    const { insertId: newId } = await db.query(
      'INSERT INTO training_plan_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
      [gymId, copyName, src.description ?? null, 'draft', gymMembershipId],
    );

    const { rows: workouts } = await db.query(
      'SELECT * FROM training_plan_template_workouts WHERE training_plan_template_id = ? ORDER BY position ASC',
      [id],
    );
    for (const w of workouts) {
      await db.query(
        'INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday) VALUES (?, ?, ?, ?, ?)',
        [gymId, newId, w.workout_template_id, w.position, w.scheduled_weekday],
      );
    }

    const { rows: newRows } = await db.query(
      `SELECT tpt.*,
              gm_c.name AS created_by_name,
              gm_m.name AS modified_by_name,
              gm_d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count
       FROM training_plan_templates tpt
       LEFT JOIN gym_memberships gm_c ON gm_c.id = tpt.created_by_membership_id
       LEFT JOIN gym_memberships gm_m ON gm_m.id = tpt.modified_by_membership_id
       LEFT JOIN gym_memberships gm_d ON gm_d.id = tpt.deleted_by_membership_id
       WHERE tpt.id = ?`,
      [newId],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: newId, next: newRows[0] });
    res.status(201).json(newRows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A template with this name already exists.' });
    next(err);
  }
});

/* ---- TrainingPlanTemplateWorkout (junction) ---- */

trainingPlanTemplatesRouter.get('/:id/workouts', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? AND j.gym_id = ? ORDER BY j.position ASC`,
      [id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.post('/:id/workouts', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
  const workoutTemplateId = Number(req.body.workout_template_id);
  if (!Number.isInteger(workoutTemplateId) || workoutTemplateId <= 0) {
    return res.status(400).json({ error: 'workout_template_id is required' });
  }
  const scheduledWeekday = req.body.scheduled_weekday == null || req.body.scheduled_weekday === ''
    ? null : Number(req.body.scheduled_weekday);
  if (scheduledWeekday !== null && (scheduledWeekday < 0 || scheduledWeekday > 6)) {
    return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  }
  try {
    const { rows: wtRows } = await db.query(
      'SELECT 1 FROM workout_templates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [workoutTemplateId, gymId],
    );
    if (wtRows.length === 0) return res.status(400).json({ error: 'workout_template_id does not belong to this gym' });

    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM training_plan_template_workouts WHERE training_plan_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      `INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday)
       VALUES (?, ?, ?, ?, ?)`,
      [gymId, id, workoutTemplateId, posRows[0].next_position, scheduledWeekday],
    );
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id WHERE j.id = ?`,
      [insertId],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template_workout', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.put('/:id/workouts/reorder', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of junction-row ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'training_plan_template_workouts', 'training_plan_template_id', id, order));
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? AND j.gym_id = ? ORDER BY j.position ASC`,
      [id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.put('/:id/workouts/:linkId', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, linkId } = req.params as { id: string; linkId: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
  const scheduledWeekday = req.body.scheduled_weekday == null || req.body.scheduled_weekday === ''
    ? null : Number(req.body.scheduled_weekday);
  if (scheduledWeekday !== null && (scheduledWeekday < 0 || scheduledWeekday > 6)) {
    return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_template_workouts SET scheduled_weekday = ?
       WHERE id = ? AND training_plan_template_id = ? AND gym_id = ?`,
      [scheduledWeekday, linkId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Link not found' });
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id WHERE j.id = ?`,
      [linkId],
    );
    recordAudit(req, { action: 'update', entityType: 'training_plan_template_workout', entityId: linkId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.delete('/:id/workouts/:linkId', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { id, linkId } = req.params as { id: string; linkId: string };
  const { rowCount } = await db.query(
    'DELETE FROM training_plan_template_workouts WHERE id = ? AND training_plan_template_id = ? AND gym_id = ?',
    [linkId, id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Link not found' });
  recordAudit(req, { action: 'delete', entityType: 'training_plan_template_workout', entityId: linkId });
  res.status(204).send();
});

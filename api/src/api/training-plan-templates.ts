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
  try {
    const params: any[] = [gymId];
    let sql = "SELECT * FROM training_plan_templates WHERE gym_id = ? AND status != 'deleted'";
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY name ASC';
    const { rows } = await db.query(sql, params);
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
      `SELECT tpt.*,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', j.id, 'position', j.position, 'scheduled_weekday', j.scheduled_weekday,
              'workout_template_id', j.workout_template_id, 'workout_template_name', wt.name) AS item
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
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_templates SET
        name = COALESCE(?, name), description = IF(?, ?, description), status = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null, id, gymId],
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
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { rowCount } = await db.query(
    "UPDATE training_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Training plan template not found' });
  recordAudit(req, { action: 'delete', entityType: 'training_plan_template', entityId: id });
  res.status(204).send();
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

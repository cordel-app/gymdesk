import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';

export const platformTrainingPlanTemplatesRouter = Router();

const STATUSES = ['active', 'inactive', 'draft', 'deleted'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

async function templateExists(id: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM training_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
    [id],
  );
  return rows.length > 0;
}

/* ── TrainingPlanTemplate ────────────────────────────────────────────────── */

platformTrainingPlanTemplatesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const where: string[] = ["tpt.gym_id IS NULL", "tpt.status != 'deleted'"];
    const params: any[] = [];
    if (status) { where.push('tpt.status = ?'); params.push(status); }
    if (name) { where.push('tpt.name LIKE ?'); params.push(`%${name}%`); }
    const whereSql = where.join(' AND ');
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM training_plan_templates tpt WHERE ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT tpt.*,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count
       FROM training_plan_templates tpt
       WHERE ${whereSql}
       ORDER BY tpt.name ASC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
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
       FROM training_plan_templates tpt
       WHERE tpt.id = ? AND tpt.gym_id IS NULL AND tpt.status != 'deleted'`,
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const row = await insertAndFetch(
      'INSERT INTO training_plan_templates (gym_id, name, description, status) VALUES (NULL, ?, ?, ?)',
      [name.trim(), description ?? null, status ?? 'active'],
      'SELECT * FROM training_plan_templates WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_templates SET
        name = COALESCE(?, name), description = IF(?, ?, description), status = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id IS NULL AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null, id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Training plan template not found' });
    const { rows } = await db.query('SELECT * FROM training_plan_templates WHERE id = ?', [id]);
    recordAudit(req, { action: 'update', entityType: 'training_plan_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    const { rowCount } = await db.query(
      "UPDATE training_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Training plan template not found' });
    recordAudit(req, { action: 'delete', entityType: 'training_plan_template', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── TrainingPlanTemplateWorkout (junction) ──────────────────────────────── */

platformTrainingPlanTemplatesRouter.get('/:id/workouts', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id))) return res.status(404).json({ error: 'Training plan template not found' });
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? AND j.gym_id IS NULL ORDER BY j.position ASC`,
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.post('/:id/workouts', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await templateExists(id))) return res.status(404).json({ error: 'Training plan template not found' });
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
      'SELECT 1 FROM workout_templates WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL',
      [workoutTemplateId],
    );
    if (wtRows.length === 0) return res.status(400).json({ error: 'workout_template_id is not a base workout template' });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM training_plan_template_workouts WHERE training_plan_template_id = ?',
      [id],
    );
    const row = await insertAndFetch(
      `INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday)
       VALUES (NULL, ?, ?, ?, ?)`,
      [id, workoutTemplateId, posRows[0].next_position, scheduledWeekday],
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id WHERE j.id = ?`,
      (linkId) => [linkId],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template_workout', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.put('/:id/workouts/reorder', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await templateExists(id))) return res.status(404).json({ error: 'Training plan template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of junction-row ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'training_plan_template_workouts', 'training_plan_template_id', id, order));
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? AND j.gym_id IS NULL ORDER BY j.position ASC`,
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.put('/:id/workouts/:linkId', requireSuperadmin, async (req, res, next) => {
  const { id, linkId } = req.params as { id: string; linkId: string };
  if (!(await templateExists(id))) return res.status(404).json({ error: 'Training plan template not found' });
  const scheduledWeekday = req.body.scheduled_weekday == null || req.body.scheduled_weekday === ''
    ? null : Number(req.body.scheduled_weekday);
  if (scheduledWeekday !== null && (scheduledWeekday < 0 || scheduledWeekday > 6)) {
    return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  }
  try {
    const { rowCount } = await db.query(
      'UPDATE training_plan_template_workouts SET scheduled_weekday = ? WHERE id = ? AND training_plan_template_id = ? AND gym_id IS NULL',
      [scheduledWeekday, linkId, id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Link not found' });
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id WHERE j.id = ?`,
      [linkId],
    );
    recordAudit(req, { action: 'update', entityType: 'training_plan_template_workout', entityId: linkId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformTrainingPlanTemplatesRouter.delete('/:id/workouts/:linkId', requireSuperadmin, async (req, res, next) => {
  const { id, linkId } = req.params as { id: string; linkId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM training_plan_template_workouts WHERE id = ? AND training_plan_template_id = ? AND gym_id IS NULL',
      [linkId, id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Link not found' });
    recordAudit(req, { action: 'delete', entityType: 'training_plan_template_workout', entityId: linkId });
    res.status(204).send();
  } catch (err) { next(err); }
});

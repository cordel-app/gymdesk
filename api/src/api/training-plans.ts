import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * P5.3 + P5.4: training_plan_templates (blueprints) and per-member
 * training_plans. Assigning from a template copies the template's fields into
 * the new plan row (later template edits DO NOT propagate — that's a
 * deliberate freeze so existing assignments stay stable).
 *
 * "One active plan per member per weekday" is enforced by the P5.4
 * generated-column unique index. Server auto-deactivates the previous plan
 * on the same weekday to give a smoother UX than a 409 to the caller.
 */

export const trainingTemplatesRouter = Router();

trainingTemplatesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  const params: any[] = [gymId];
  let sql = `SELECT tpt.*, w.name AS workout_name FROM training_plan_templates tpt
             JOIN workouts w ON w.id = tpt.workout_id
             WHERE tpt.gym_id = ?`;
  if (status) { sql += ' AND tpt.status = ?'; params.push(status); }
  sql += ' ORDER BY tpt.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

trainingTemplatesRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, workout_id, reps, rest_seconds, weekday, status } = req.body;
  if (!name?.trim() || !workout_id) return res.status(400).json({ error: 'name and workout_id are required' });
  const { rows: wRows } = await db.query('SELECT id FROM workouts WHERE id = ? AND gym_id = ?', [workout_id, gymId]);
  if (wRows.length === 0) return res.status(404).json({ error: 'Workout not found' });
  try {
    const { insertId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, description, workout_id, reps, rest_seconds, weekday, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null, workout_id, reps ?? null, rest_seconds ?? null, weekday ?? null, status ?? 'active'],
    );
    const { rows } = await db.query('SELECT * FROM training_plan_templates WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

trainingTemplatesRouter.put('/:id', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, workout_id, reps, rest_seconds, weekday, status } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_templates SET
        name         = COALESCE(?, name),
        description  = IF(?, ?, description),
        workout_id   = COALESCE(?, workout_id),
        reps         = IF(?, ?, reps),
        rest_seconds = IF(?, ?, rest_seconds),
        weekday      = IF(?, ?, weekday),
        status       = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        workout_id ?? null,
        'reps' in req.body ? 1 : 0, reps ?? null,
        'rest_seconds' in req.body ? 1 : 0, rest_seconds ?? null,
        'weekday' in req.body ? 1 : 0, weekday ?? null,
        status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await db.query('SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

trainingTemplatesRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM training_plan_templates WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Template not found' });
  res.status(204).send();
});

/* ---------- member training plans ---------- */
export const memberTrainingPlansRouter = Router({ mergeParams: true });

const PLAN_SELECT = `
  SELECT tp.*, w.name AS workout_name
  FROM training_plans tp
  JOIN workouts w ON w.id = tp.workout_id
`;

memberTrainingPlansRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = (req.params as any).memberId;
  const { rows } = await db.query(
    `${PLAN_SELECT} WHERE tp.gym_id = ? AND tp.member_id = ?
     ORDER BY tp.deactivated_at IS NOT NULL, tp.activated_at DESC`,
    [gymId, memberId],
  );
  res.json(rows);
});

memberTrainingPlansRouter.post('/', requireRole('admin', 'coach', 'staff'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const memberId = parseInt((req.params as any).memberId, 10);
  const { template_id, name, description, workout_id, reps, rest_seconds, weekday } = req.body;

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  // Resolve from template or ad hoc; ad-hoc requires name + workout_id.
  let planFields: any;
  if (template_id) {
    const { rows: tRows } = await db.query(
      'SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ?',
      [template_id, gymId],
    );
    if (tRows.length === 0) return res.status(404).json({ error: 'Template not found' });
    if (tRows[0].status !== 'active') return res.status(400).json({ error: 'Template is inactive' });
    const t = tRows[0];
    planFields = {
      name: name?.trim() ?? t.name,
      description: description ?? t.description,
      workout_id: workout_id ?? t.workout_id,
      reps: reps ?? t.reps,
      rest_seconds: rest_seconds ?? t.rest_seconds,
      weekday: weekday !== undefined ? weekday : t.weekday,
      template_id,
    };
  } else {
    if (!name?.trim() || !workout_id) return res.status(400).json({ error: 'name and workout_id are required for an ad-hoc plan' });
    const { rows: wRows } = await db.query('SELECT id FROM workouts WHERE id = ? AND gym_id = ?', [workout_id, gymId]);
    if (wRows.length === 0) return res.status(404).json({ error: 'Workout not found' });
    planFields = { name: name.trim(), description: description ?? null, workout_id, reps: reps ?? null, rest_seconds: rest_seconds ?? null, weekday: weekday ?? null, template_id: null };
  }

  try {
    const insertId = await db.transaction(async (tx) => {
      // Deactivate previous active plan for the same weekday, if any.
      if (planFields.weekday !== null && planFields.weekday !== undefined) {
        await tx.query(
          `UPDATE training_plans SET deactivated_at = UTC_TIMESTAMP()
           WHERE gym_id = ? AND member_id = ? AND weekday = ? AND deactivated_at IS NULL`,
          [gymId, memberId, planFields.weekday],
        );
      }
      const { insertId } = await tx.query(
        `INSERT INTO training_plans
         (gym_id, member_id, workout_id, template_id, name, description, reps, rest_seconds, weekday, assigned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, memberId, planFields.workout_id, planFields.template_id,
         planFields.name, planFields.description, planFields.reps, planFields.rest_seconds,
         planFields.weekday, userId],
      );
      return insertId;
    });
    const { rows } = await db.query(`${PLAN_SELECT} WHERE tp.id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

memberTrainingPlansRouter.delete('/:id', requireRole('admin', 'coach', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = (req.params as any).memberId;
  const { rowCount } = await db.query(
    `UPDATE training_plans SET deactivated_at = UTC_TIMESTAMP()
     WHERE id = ? AND gym_id = ? AND member_id = ? AND deactivated_at IS NULL`,
    [req.params.id, gymId, memberId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Active plan not found' });
  res.status(204).send();
});

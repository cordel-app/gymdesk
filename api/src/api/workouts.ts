import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * P5.2: workouts + ordered exercise items. Per-item reps/rest override the
 * exercise's default_reps/default_rest_seconds — the response resolves
 * effective values so callers don't have to.
 */

const WORKOUT_SELECT = `
  SELECT w.*,
    (
      SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'id', we.id, 'exercise_id', we.exercise_id, 'position', we.position,
        'reps', COALESCE(we.reps, e.default_reps),
        'rest_seconds', COALESCE(we.rest_seconds, e.default_rest_seconds),
        'name', e.name, 'video_url', e.video_url, 'image_url', e.image_url,
        'override_reps', we.reps,
        'override_rest_seconds', we.rest_seconds
      ))
      FROM (
        SELECT * FROM workout_exercises WHERE workout_id = w.id ORDER BY position ASC
      ) we
      JOIN exercises e ON e.id = we.exercise_id
    ) AS exercises
  FROM workouts w
`;

export const workoutsRouter = Router();

workoutsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${WORKOUT_SELECT} WHERE w.gym_id = ? ORDER BY w.name ASC`, [gymId]);
  res.json(rows);
});

workoutsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${WORKOUT_SELECT} WHERE w.id = ? AND w.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Workout not found' });
  res.json(rows[0]);
});

workoutsRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, weekday, exercises } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (weekday != null && (weekday < 0 || weekday > 6)) return res.status(400).json({ error: 'weekday must be 0–6' });
  try {
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO workouts (gym_id, name, description, weekday) VALUES (?, ?, ?, ?)',
        [gymId, name.trim(), description ?? null, weekday ?? null],
      );
      if (Array.isArray(exercises)) {
        for (let i = 0; i < exercises.length; i++) {
          const ex = exercises[i];
          if (!ex.exercise_id) continue;
          await tx.query(
            'INSERT INTO workout_exercises (gym_id, workout_id, exercise_id, position, reps, rest_seconds) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, insertId, ex.exercise_id, i, ex.reps ?? null, ex.rest_seconds ?? null],
          );
        }
      }
      return insertId;
    });
    const { rows } = await db.query(`${WORKOUT_SELECT} WHERE w.id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

workoutsRouter.put('/:id', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, weekday, exercises } = req.body;
  if (weekday !== undefined && weekday !== null && (weekday < 0 || weekday > 6)) return res.status(400).json({ error: 'weekday must be 0–6' });
  try {
    await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE workouts SET
          name        = COALESCE(?, name),
          description = IF(?, ?, description),
          weekday     = IF(?, ?, weekday)
         WHERE id = ? AND gym_id = ?`,
        [
          name?.trim() ?? null,
          'description' in req.body ? 1 : 0, description ?? null,
          'weekday' in req.body ? 1 : 0, weekday ?? null,
          req.params.id, gymId,
        ],
      );
      if (rowCount === 0) throw Object.assign(new Error('Workout not found'), { status: 404 });
      if (Array.isArray(exercises)) {
        await tx.query('DELETE FROM workout_exercises WHERE workout_id = ? AND gym_id = ?', [req.params.id, gymId]);
        for (let i = 0; i < exercises.length; i++) {
          const ex = exercises[i];
          if (!ex.exercise_id) continue;
          await tx.query(
            'INSERT INTO workout_exercises (gym_id, workout_id, exercise_id, position, reps, rest_seconds) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, req.params.id, ex.exercise_id, i, ex.reps ?? null, ex.rest_seconds ?? null],
          );
        }
      }
    });
    const { rows } = await db.query(`${WORKOUT_SELECT} WHERE w.id = ? AND w.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

workoutsRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM workouts WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Workout not found' });
  res.status(204).send();
});

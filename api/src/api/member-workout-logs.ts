import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * P5.5: coach-side view of a member's workout logs. Gym-scoped; no member
 * write access here (member logs via /me/workout-logs).
 */
export const memberWorkoutLogsRouter = Router({ mergeParams: true });

memberWorkoutLogsRouter.get('/', requireRole('admin', 'coach', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = (req.params as any).memberId;
  const { rows: mRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ?',
    [memberId, gymId],
  );
  if (mRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const { rows } = await db.query(
    `SELECT wl.id, wl.logged_date, wl.series, wl.weight, wl.reps,
            e.id AS exercise_id, e.name AS exercise_name
     FROM workout_logs wl
     JOIN workout_exercises we ON we.id = wl.workout_exercise_id
     JOIN exercises e ON e.id = we.exercise_id
     WHERE wl.gym_id = ? AND wl.member_id = ?
     ORDER BY wl.logged_date DESC, wl.series ASC`,
    [gymId, memberId],
  );
  res.json(rows);
});

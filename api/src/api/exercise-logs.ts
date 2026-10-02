import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { localizedExerciseNameExpr } from '../domain/exerciseTranslations';
import { getRequestLocale } from '../infra/locale';

/**
 * #55: staff-side read visibility into a member's ExerciseLog/WorkoutBlockLog
 * history. Mirrors the legacy member-workout-logs.ts's GET-only shape — the
 * write side lives in me.ts (member self-service, ownership-checked).
 */

export const exerciseLogsRouter = Router({ mergeParams: true });
export const workoutBlockLogsRouter = Router({ mergeParams: true });

exerciseLogsRouter.get('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  const exercise = req.query.exercise as string | undefined;
  try {
    // MySQL's JSON_ARRAYAGG has no ORDER BY of its own — aggregate over a
    // derived table pre-sorted by set_number instead.
    const params: any[] = [memberId, gymId];
    // #967: the exercise's name in the caller's language, falling back to its
    // base name. A read-only surface takes the localized value in the field it
    // already reads — only the exercises routers keep `name` separate, because
    // their rows back an edit form.
    let sql = `
      SELECT el.*, ${localizedExerciseNameExpr('e', getRequestLocale(req))},
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT('id', s.id, 'set_number', s.set_number, 'weight', s.weight, 'reps', s.reps, 'rpe', s.rpe) AS item
          FROM exercise_log_sets s WHERE s.exercise_log_id = el.id ORDER BY s.set_number
        ) t) AS sets
      FROM exercise_logs el JOIN exercises e ON e.id = el.exercise_id
      WHERE el.member_id = ? AND el.gym_id = ?`;
    if (exercise) { sql += ' AND el.exercise_id = ?'; params.push(exercise); }
    sql += ' ORDER BY el.logged_date DESC, el.id DESC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

workoutBlockLogsRouter.get('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  try {
    const { rows } = await db.query(
      `SELECT wbl.* FROM workout_block_logs wbl
       WHERE wbl.member_id = ? AND wbl.gym_id = ? ORDER BY wbl.logged_date DESC, wbl.id DESC`,
      [memberId, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

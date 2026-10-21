import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { getRequestLocale } from '../infra/locale';
import { localizedExerciseNameExpr, exerciseNameSearchSql } from '../domain/exerciseTranslations';
import { effectiveImageThumbnailUrlSql, imageSexForGender } from '../domain/effectiveExerciseImage';
import { MUSCLE_SLUG_SQL } from './exercise-muscles';
import { resolveMemberId } from './me';

/**
 * #1916 — standalone exercises: an exercise a member adds to one day of My
 * Training without touching their Training Plan, mounted at
 * `/me/standalone-exercises`.
 *
 * The addition is `member_standalone_exercises`; what the member performed is
 * the existing `exercise_logs` model (`POST /me/exercise-logs` with
 * `standalone_exercise_id`). The member is never named by the request
 * (`resolveMemberId()`) and every query constrains `(gym_id, member_id)`.
 */
export const meStandaloneExercisesRouter = Router();

meStandaloneExercisesRouter.use(
  requireRole('member'),
  requireFeatureEnabled('training'),
  requireFeatureEnabled('member_web.my_training_plan'),
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const json = (v: unknown): any => {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

async function memberSex(gymId: string, memberId: number) {
  const { rows } = await db.query('SELECT gender FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  return imageSexForGender(rows[0]?.gender);
}

/** The gym's active exercises the member may add, searchable by name. */
meStandaloneExercisesRouter.get('/catalogue', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const memberId = await resolveMemberId(gymId, getTenantContext(req));
    const sex = await memberSex(gymId, memberId);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const params: any[] = [gymId];
    let where = "e.gym_id = ? AND e.status = 'active' AND e.deleted_at IS NULL";
    if (q) {
      where += ` AND ${exerciseNameSearchSql('e')}`;
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    const { rows } = await db.query(
      `SELECT e.id, ${localizedExerciseNameExpr('e', getRequestLocale(req), 'name')},
              ${effectiveImageThumbnailUrlSql('e', sex)} AS image_thumbnail_url,
              (SELECT ${MUSCLE_SLUG_SQL} FROM exercise_muscles em WHERE em.exercise_id = e.id AND em.role = 'principal' ORDER BY em.id LIMIT 1) AS primary_muscle
       FROM exercises e WHERE ${where} ORDER BY name LIMIT 100`,
      params,
    );
    res.json(rows);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** The member's standalone exercises of one day, each with that day's logged sets. */
meStandaloneExercisesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const date = req.query.date;
  if (!validDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const memberId = await resolveMemberId(gymId, getTenantContext(req));
    const sex = await memberSex(gymId, memberId);
    const { rows } = await db.query(
      `SELECT s.id, s.exercise_id, s.exercise_date, ${localizedExerciseNameExpr('e', getRequestLocale(req), 'exercise_name')},
              ${effectiveImageThumbnailUrlSql('e', sex)} AS image_thumbnail_url,
              (SELECT ${MUSCLE_SLUG_SQL} FROM exercise_muscles em WHERE em.exercise_id = e.id AND em.role = 'principal' ORDER BY em.id LIMIT 1) AS primary_muscle,
              (SELECT JSON_ARRAYAGG(item) FROM (
                 SELECT JSON_OBJECT('id', l.id, 'sets', (
                          SELECT JSON_ARRAYAGG(JSON_OBJECT('id', ls.id, 'set_number', ls.set_number, 'weight', ls.weight, 'reps', ls.reps))
                          FROM exercise_log_sets ls WHERE ls.exercise_log_id = l.id)) AS item
                 FROM exercise_logs l WHERE l.standalone_exercise_id = s.id ORDER BY l.id
               ) t) AS logs
       FROM member_standalone_exercises s JOIN exercises e ON e.id = s.exercise_id
       WHERE s.gym_id = ? AND s.member_id = ? AND s.exercise_date = ? ORDER BY s.id`,
      [gymId, memberId, date],
    );
    res.json(rows.map((r: any) => ({ ...r, logs: json(r.logs) ?? [] })));
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Add an active exercise of the member's gym to a day. */
meStandaloneExercisesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const exerciseId = Number(req.body?.exercise_id);
  const date = req.body?.date;
  if (!Number.isInteger(exerciseId) || exerciseId < 1) return res.status(400).json({ error: 'exercise_id is required' });
  if (!validDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const memberId = await resolveMemberId(gymId, getTenantContext(req));
    const { rows } = await db.query(
      "SELECT id FROM exercises WHERE id = ? AND gym_id = ? AND status = 'active' AND deleted_at IS NULL",
      [exerciseId, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    try {
      const { insertId } = await db.query(
        'INSERT INTO member_standalone_exercises (gym_id, member_id, exercise_id, exercise_date) VALUES (?, ?, ?, ?)',
        [gymId, memberId, exerciseId, date],
      );
      res.status(201).json({ id: insertId, exercise_id: exerciseId, exercise_date: date });
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This exercise is already added to that day.' });
      throw err;
    }
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Remove an addition — only while nothing has been registered on it. */
meStandaloneExercisesRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const memberId = await resolveMemberId(gymId, getTenantContext(req));
    const { rows } = await db.query(
      'SELECT id FROM member_standalone_exercises WHERE id = ? AND gym_id = ? AND member_id = ?',
      [req.params.id, gymId, memberId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Standalone exercise not found' });
    const { rows: logs } = await db.query('SELECT 1 FROM exercise_logs WHERE standalone_exercise_id = ? LIMIT 1', [req.params.id]);
    if (logs.length > 0) return res.status(409).json({ error: 'Performance is already registered for this exercise.' });
    await db.query('DELETE FROM member_standalone_exercises WHERE id = ? AND gym_id = ? AND member_id = ?', [req.params.id, gymId, memberId]);
    res.json({ deleted: true });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

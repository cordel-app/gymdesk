import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { getRequestLocale } from '../infra/locale';
import { localizedExerciseNameExpr } from '../domain/exerciseTranslations';
import { effectiveImageThumbnailUrlSql, effectiveImageUrlSql, imageSexForGender } from '../domain/effectiveExerciseImage';
import {
  defaultResultType, progressDays, summarizeExercise,
  type AllowedResultType, type ProgressLog,
} from '../domain/exerciseProgress';
import { resolveMemberId } from './me';

/**
 * #1224 — the Members App's **My Progress** tab, mounted at `/me/progress`.
 *
 * Every figure is derived on read by `domain/exerciseProgress.ts` from the
 * member's `exercise_logs` (with `exercise_log_sets` read-only for weight and
 * reps); nothing is stored. The history belongs to the member and the exercise,
 * never to a plan, so no plan status is consulted. The member is never named by
 * the request (`resolveMemberId()`) and every query constrains `(gym_id,
 * member_id)`.
 */
export const meProgressRouter = Router();

meProgressRouter.use(
  requireRole('member'),
  requireFeatureEnabled('training'),
  requireFeatureEnabled('member_web.my_training_plan'),
);

const json = (v: unknown): any => {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

function toLog(r: any): ProgressLog {
  const sets = (json(r.sets) ?? []) as any[];
  const d = r.logged_date instanceof Date ? r.logged_date.toISOString().slice(0, 10) : String(r.logged_date).slice(0, 10);
  return {
    logged_date: d,
    duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
    skipped: Boolean(r.skipped),
    sets: sets.map((s) => ({
      set_number: Number(s.set_number),
      weight: s.weight === null || s.weight === undefined ? null : Number(s.weight),
      reps: s.reps === null || s.reps === undefined ? null : Number(s.reps),
    })),
  };
}

const LOG_SELECT = `el.exercise_id, el.logged_date, el.duration_seconds, el.skipped,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('set_number', s.set_number, 'weight', s.weight, 'reps', s.reps))
     FROM exercise_log_sets s WHERE s.exercise_log_id = el.id AND s.gym_id = el.gym_id) AS sets`;

const allowedTypesSql = `(SELECT JSON_ARRAYAGG(JSON_OBJECT('id', rt.id, 'slug', rt.slug, 'name', rt.name))
   FROM exercise_allowed_result_types ar JOIN result_types rt ON rt.id = ar.result_type_id
   WHERE ar.exercise_id = e.id) AS allowed_result_types`;

async function memberSex(gymId: string, memberId: number) {
  const { rows } = await db.query('SELECT gender FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  return imageSexForGender(rows[0]?.gender);
}

meProgressRouter.get('/exercises', async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    let memberId: number;
    try { memberId = await resolveMemberId(gymId, ctx); } catch { return res.json([]); }
    const sex = await memberSex(gymId, memberId);
    const { rows: logRows } = await db.query(
      `SELECT ${LOG_SELECT} FROM exercise_logs el WHERE el.gym_id = ? AND el.member_id = ?`,
      [gymId, memberId],
    );
    const byExercise = new Map<number, ProgressLog[]>();
    for (const r of logRows) {
      const list = byExercise.get(Number(r.exercise_id)) ?? [];
      list.push(toLog(r));
      byExercise.set(Number(r.exercise_id), list);
    }
    if (byExercise.size === 0) return res.json([]);
    const ids = [...byExercise.keys()];
    const { rows: exRows } = await db.query(
      `SELECT e.id, ${localizedExerciseNameExpr('e', getRequestLocale(req))},
              ${effectiveImageUrlSql('e', sex)} AS image_url,
              ${effectiveImageThumbnailUrlSql('e', sex)} AS image_thumbnail_url,
              ${allowedTypesSql}
       FROM exercises e WHERE e.id IN (${ids.map(() => '?').join(',')}) AND (e.gym_id = ? OR e.gym_id IS NULL)`,
      [...ids, gymId],
    );
    const out = exRows.map((ex: any) => {
      const allowed: AllowedResultType[] = (json(ex.allowed_result_types) ?? []).map((a: any) => ({ id: Number(a.id), slug: a.slug }));
      return {
        exercise_id: Number(ex.id),
        exercise_name: ex.exercise_name,
        image_url: ex.image_url ?? null,
        image_thumbnail_url: ex.image_thumbnail_url ?? null,
        ...summarizeExercise(byExercise.get(Number(ex.id)) ?? [], allowed),
      };
    }).filter((ex: any) => ex.days_exercised > 0)
      .sort((a: any, b: any) => String(a.exercise_name).localeCompare(String(b.exercise_name)));
    res.json(out);
  } catch (err) { next(err); }
});

meProgressRouter.get('/exercises/:exerciseId', async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const exerciseId = Number(req.params.exerciseId);
  if (!Number.isInteger(exerciseId) || exerciseId < 1) return res.status(400).json({ error: 'Invalid exercise id' });
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: logRows } = await db.query(
      `SELECT ${LOG_SELECT} FROM exercise_logs el
       WHERE el.gym_id = ? AND el.member_id = ? AND el.exercise_id = ?`,
      [gymId, memberId, exerciseId],
    );
    if (logRows.length === 0) return res.status(404).json({ error: 'No progress for this exercise' });
    const { rows: exRows } = await db.query(
      `SELECT e.id, ${localizedExerciseNameExpr('e', getRequestLocale(req))}, ${allowedTypesSql}
       FROM exercises e WHERE e.id = ? AND (e.gym_id = ? OR e.gym_id IS NULL)`,
      [exerciseId, gymId],
    );
    if (exRows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    const allowed: AllowedResultType[] = (json(exRows[0].allowed_result_types) ?? []).map((a: any) => ({ id: Number(a.id), slug: a.slug }));
    const logs = logRows.map(toLog);
    res.json({
      exercise_id: exerciseId,
      exercise_name: exRows[0].exercise_name,
      ...summarizeExercise(logs, allowed),
      days: progressDays(logs, defaultResultType(allowed)),
    });
  } catch (err) { next(err); }
});

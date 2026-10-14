import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { getRequestLocale } from '../infra/locale';
import { localizedExerciseNameExpr } from '../domain/exerciseTranslations';
import { effectiveImageThumbnailUrlSql, effectiveImageUrlSql, imageSexForGender } from '../domain/effectiveExerciseImage';
import {
  defaultResultType, progressDays, summarizeExercise,
  type AllowedResultType, type ProgressLog,
} from '../domain/exerciseProgress';
import { allowedTypesSql, json, LOG_SELECT, toLog } from './me-progress';

/**
 * #1231 — the staff **Progress** tab of the Member card, mounted at
 * `/members/:memberId/progress` behind TRAINING access.
 *
 * It is #1224's derived progress read for a member the caller names in the URL:
 * the figures are `domain/exerciseProgress.ts`'s, so the staff and the member
 * views cannot disagree. Beyond the read it adds the readings (the individual
 * `exercise_logs`) with the two agreed writes: an edit of a reading's value
 * (duration and per-set weight/reps) and notes — never its date — and a hard
 * delete. Neither writes an `audit_logs` row (the owner's answer on #1231).
 */
export const memberProgressRouter = Router({ mergeParams: true });

async function loadMember(gymId: string, raw: string) {
  const memberId = Number(raw);
  if (!Number.isInteger(memberId) || memberId < 1) return null;
  const { rows } = await db.query('SELECT id, gender FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  return rows[0] ? { id: memberId, gender: rows[0].gender } : null;
}

const asAllowed = (v: unknown): AllowedResultType[] =>
  (json(v) ?? []).map((a: any) => ({ id: Number(a.id), slug: a.slug }));

memberProgressRouter.get('/exercises', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const member = await loadMember(gymId, (req.params as any).memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const sex = imageSexForGender(member.gender);
    const { rows: logRows } = await db.query(
      `SELECT ${LOG_SELECT} FROM exercise_logs el WHERE el.gym_id = ? AND el.member_id = ?`,
      [gymId, member.id],
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
    const out = exRows.map((ex: any) => ({
      exercise_id: Number(ex.id),
      exercise_name: ex.exercise_name,
      image_url: ex.image_url ?? null,
      image_thumbnail_url: ex.image_thumbnail_url ?? null,
      ...summarizeExercise(byExercise.get(Number(ex.id)) ?? [], asAllowed(ex.allowed_result_types)),
    })).filter((ex: any) => ex.days_exercised > 0)
      .sort((a: any, b: any) => String(a.exercise_name).localeCompare(String(b.exercise_name)));
    res.json(out);
  } catch (err) { next(err); }
});

/** Everything the expanded card needs: summary, graph days and the readings. */
async function exerciseDetail(gymId: string, memberId: number, exerciseId: number, locale: string | undefined, req: Request) {
  const { rows: logRows } = await db.query(
    `SELECT el.id, el.notes, el.modified_at, ${LOG_SELECT}
     FROM exercise_logs el WHERE el.gym_id = ? AND el.member_id = ? AND el.exercise_id = ?
     ORDER BY el.logged_date DESC, el.id DESC`,
    [gymId, memberId, exerciseId],
  );
  if (logRows.length === 0) return null;
  const { rows: exRows } = await db.query(
    `SELECT e.id, ${localizedExerciseNameExpr('e', getRequestLocale(req))}, ${allowedTypesSql}
     FROM exercises e WHERE e.id = ? AND (e.gym_id = ? OR e.gym_id IS NULL)`,
    [exerciseId, gymId],
  );
  if (exRows.length === 0) return null;
  const allowed = asAllowed(exRows[0].allowed_result_types);
  const logs = logRows.map(toLog);
  // Readings carry the full set rows (id + rpe) so the edit form can address them.
  const { rows: setRows } = await db.query(
    `SELECT s.id, s.exercise_log_id, s.set_number, s.weight, s.reps, s.rpe
     FROM exercise_log_sets s WHERE s.gym_id = ? AND s.exercise_log_id IN (${logRows.map(() => '?').join(',')})
     ORDER BY s.set_number`,
    [gymId, ...logRows.map((r: any) => r.id)],
  );
  const readings = logRows.map((r: any, i: number) => ({
    id: Number(r.id),
    logged_date: logs[i].logged_date,
    notes: r.notes ?? null,
    duration_seconds: logs[i].duration_seconds,
    skipped: logs[i].skipped,
    sets: setRows.filter((s: any) => Number(s.exercise_log_id) === Number(r.id)).map((s: any) => ({
      id: Number(s.id),
      set_number: Number(s.set_number),
      weight: s.weight === null ? null : Number(s.weight),
      reps: s.reps === null ? null : Number(s.reps),
      rpe: s.rpe === null ? null : Number(s.rpe),
    })),
  }));
  return {
    exercise_id: exerciseId,
    exercise_name: exRows[0].exercise_name,
    ...summarizeExercise(logs, allowed),
    days: progressDays(logs, defaultResultType(allowed)),
    readings,
  };
}

memberProgressRouter.get('/exercises/:exerciseId', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const exerciseId = Number(req.params.exerciseId);
  if (!Number.isInteger(exerciseId) || exerciseId < 1) return res.status(400).json({ error: 'Invalid exercise id' });
  try {
    const member = await loadMember(gymId, (req.params as any).memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const detail = await exerciseDetail(gymId, member.id, exerciseId, undefined, req);
    if (!detail) return res.status(404).json({ error: 'No progress for this exercise' });
    res.json(detail);
  } catch (err) { next(err); }
});

const nonNegative = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

memberProgressRouter.put('/readings/:logId', requireModuleWrite('TRAINING'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const logId = Number(req.params.logId);
  if (!Number.isInteger(logId) || logId < 1) return res.status(400).json({ error: 'Invalid reading id' });
  const body = req.body ?? {};
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    return res.status(400).json({ error: 'notes must be text' });
  }
  if (body.duration_seconds !== undefined && body.duration_seconds !== null && nonNegative(body.duration_seconds) === undefined) {
    return res.status(400).json({ error: 'duration_seconds must be a non-negative number' });
  }
  const sets: Array<{ id: number; weight?: any; reps?: any }> = Array.isArray(body.sets) ? body.sets : [];
  for (const s of sets) {
    if (!Number.isInteger(Number(s?.id))
      || (s.weight !== undefined && nonNegative(s.weight) === undefined)
      || (s.reps !== undefined && (nonNegative(s.reps) === undefined || (s.reps !== null && s.reps !== '' && !Number.isInteger(Number(s.reps)))))) {
      return res.status(400).json({ error: 'Invalid set' });
    }
  }
  try {
    const member = await loadMember(gymId, (req.params as any).memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const { rows } = await db.query(
      'SELECT id, exercise_id FROM exercise_logs WHERE id = ? AND gym_id = ? AND member_id = ?',
      [logId, gymId, member.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Reading not found' });
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE exercise_logs SET
           notes = IF(?, ?, notes),
           duration_seconds = IF(?, ?, duration_seconds),
           modified_at = UTC_TIMESTAMP()
         WHERE id = ? AND gym_id = ? AND member_id = ?`,
        [
          body.notes !== undefined, body.notes === '' ? null : body.notes ?? null,
          body.duration_seconds !== undefined, nonNegative(body.duration_seconds) ?? null,
          logId, gymId, member.id,
        ],
      );
      for (const s of sets) {
        await tx.query(
          `UPDATE exercise_log_sets SET weight = IF(?, ?, weight), reps = IF(?, ?, reps)
           WHERE id = ? AND gym_id = ? AND exercise_log_id = ?`,
          [
            s.weight !== undefined, nonNegative(s.weight) ?? null,
            s.reps !== undefined, nonNegative(s.reps) ?? null,
            Number(s.id), gymId, logId,
          ],
        );
      }
    });
    const detail = await exerciseDetail(gymId, member.id, Number(rows[0].exercise_id), undefined, req);
    res.json(detail);
  } catch (err) { next(err); }
});

memberProgressRouter.delete('/readings/:logId', requireModuleWrite('TRAINING'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const logId = Number(req.params.logId);
  if (!Number.isInteger(logId) || logId < 1) return res.status(400).json({ error: 'Invalid reading id' });
  try {
    const member = await loadMember(gymId, (req.params as any).memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    // exercise_log_sets cascade with the log: a hard delete, no soft-delete state.
    const result = await db.query(
      'DELETE FROM exercise_logs WHERE id = ? AND gym_id = ? AND member_id = ?',
      [logId, gymId, member.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Reading not found' });
    res.json({ id: logId, deleted: true });
  } catch (err) { next(err); }
});

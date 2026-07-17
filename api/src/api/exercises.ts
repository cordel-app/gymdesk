import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { MUSCLE_KEYS, normalizeMuscleKey } from '../domain/muscles';
import { getReferences } from '../domain/references';

/**
 * P5.1 / #55: per-gym exercises. #62: muscles are a static in-app catalog
 * (see domain/muscles.ts) — links live in exercise_muscles keyed by muscle
 * slug. Exercise delete is a soft delete (status='deleted' + deleted_at);
 * name uniqueness among non-deleted rows is enforced here because the DB
 * unique index was dropped to let deleted names be reused.
 */

const SETTABLE_STATUSES = ['active', 'inactive'];

const DEFAULT_EXERCISES: Array<{
  name: string; principal: string[]; secondary?: string[];
  min_reps_default: number | null; max_reps_default: number | null;
  sets_default: number; rest_default_seconds: number; notes_default?: string;
}> = [
  { name: 'Bench Press', principal: ['chest'], secondary: ['triceps', 'shoulders'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Squat', principal: ['quads', 'glutes'], secondary: ['hamstrings', 'core'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 120 },
  { name: 'Deadlift', principal: ['back', 'hamstrings'], secondary: ['glutes', 'core'], min_reps_default: 5, max_reps_default: 5, sets_default: 3, rest_default_seconds: 150 },
  { name: 'Overhead Press', principal: ['shoulders'], secondary: ['triceps', 'core'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Pull-up', principal: ['back'], secondary: ['biceps'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Barbell Row', principal: ['back'], secondary: ['biceps', 'core'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Lunges', principal: ['quads', 'glutes'], secondary: ['hamstrings'], min_reps_default: 12, max_reps_default: 12, sets_default: 3, rest_default_seconds: 60 },
  { name: 'Plank', principal: ['core'], min_reps_default: null, max_reps_default: null, sets_default: 3, rest_default_seconds: 60, notes_default: '60s hold' },
];

export const musclesRouter = Router();
export const exercisesRouter = Router();

/* ---- Muscles: read-only static catalog ---- */
musclesRouter.get('/', (_req, res) => {
  res.json(MUSCLE_KEYS.map((key) => ({ key })));
});

/* ---- Exercises ---- */
const SELECT = `
  SELECT e.*,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
     FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles
  FROM exercises e
`;

/** Parses body.muscles into normalized {key, role} pairs; returns an error string on bad input. */
function parseMuscles(input: unknown): { key: string; role: 'principal' | 'secondary' }[] | string | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return 'muscles must be an array of { key, role }';
  const seen = new Set<string>();
  const parsed: { key: string; role: 'principal' | 'secondary' }[] = [];
  for (const m of input) {
    const key = normalizeMuscleKey(m?.key);
    if (!key) return `invalid muscle key: ${JSON.stringify(m?.key)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ key, role: m.role === 'secondary' ? 'secondary' : 'principal' });
  }
  return parsed;
}

async function replaceMuscles(tx: Tx, gymId: string, exerciseId: number | string, muscles: { key: string; role: string }[]) {
  await tx.query('DELETE FROM exercise_muscles WHERE exercise_id = ? AND gym_id = ?', [exerciseId, gymId]);
  for (const m of muscles) {
    await tx.query(
      'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
      [gymId, exerciseId, m.key, m.role],
    );
  }
}

/** 409-style duplicate check among non-deleted exercises (DB unique was dropped for soft delete). */
async function nameTaken(gymId: string, name: string, excludeId?: string | number): Promise<boolean> {
  const params: any[] = [gymId, name];
  let sql = "SELECT id FROM exercises WHERE gym_id = ? AND name = ? AND status != 'deleted'";
  if (excludeId !== undefined) { sql += ' AND id != ?'; params.push(excludeId); }
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

exercisesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE e.gym_id = ? AND e.status != 'deleted'`;
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  sql += ' ORDER BY e.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

exercisesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE e.id = ? AND e.gym_id = ? AND e.status != 'deleted'`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
  res.json(rows[0]);
});

/** #62: where this exercise is used (non-deleted workout templates). */
exercisesRouter.get('/:id/references', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json(await getReferences('exercise', gymId, Number(req.params.id)));
  } catch (err) { next(err); }
});

exercisesRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
    status,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  try {
    if (await nameTaken(gymId, name.trim())) {
      return res.status(409).json({ error: 'Exercise with this name already exists.' });
    }
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, name.trim(), description ?? null, video_url ?? null, image_url ?? null,
         min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
         sets_default ?? null, notes_default ?? null, status ?? 'active'],
      );
      if (muscles) await replaceMuscles(tx, gymId, insertId, muscles);
      return insertId;
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Exercise with this name already exists.' });
    next(e);
  }
});

exercisesRouter.put('/:id', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  // Express 5 types params as string | string[]; helpers expect a scalar id.
  const id = String(req.params.id);
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
    status,
  } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  try {
    if (name?.trim() && await nameTaken(gymId, name.trim(), id)) {
      return res.status(409).json({ error: 'Exercise with this name already exists.' });
    }
    await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE exercises SET
          name                  = COALESCE(?, name),
          description           = IF(?, ?, description),
          video_url             = IF(?, ?, video_url),
          image_url              = IF(?, ?, image_url),
          min_reps_default      = IF(?, ?, min_reps_default),
          max_reps_default      = IF(?, ?, max_reps_default),
          rest_default_seconds  = IF(?, ?, rest_default_seconds),
          sets_default          = IF(?, ?, sets_default),
          notes_default         = IF(?, ?, notes_default),
          status                = COALESCE(?, status)
         WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
        [
          name?.trim() ?? null,
          'description' in req.body ? 1 : 0, description ?? null,
          'video_url' in req.body ? 1 : 0, video_url ?? null,
          'image_url' in req.body ? 1 : 0, image_url ?? null,
          'min_reps_default' in req.body ? 1 : 0, min_reps_default ?? null,
          'max_reps_default' in req.body ? 1 : 0, max_reps_default ?? null,
          'rest_default_seconds' in req.body ? 1 : 0, rest_default_seconds ?? null,
          'sets_default' in req.body ? 1 : 0, sets_default ?? null,
          'notes_default' in req.body ? 1 : 0, notes_default ?? null,
          status ?? null,
          id, gymId,
        ],
      );
      if (rowCount === 0) throw Object.assign(new Error('Exercise not found'), { status: 404 });
      if (muscles) await replaceMuscles(tx, gymId, id, muscles);
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id = ?`, [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Exercise with this name already exists.' });
    next(e);
  }
});

exercisesRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE exercises SET status = 'deleted', deleted_at = UTC_TIMESTAMP()
      WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise not found' });
  recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
  res.status(204).send();
});

/** Idempotent seed of the default exercise catalog. */
exercisesRouter.post('/import-defaults', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const inserted = await db.transaction(async (tx) => {
      let count = 0;
      for (const ex of DEFAULT_EXERCISES) {
        // Skip if the gym already has a non-deleted exercise with this name.
        const { rows: existing } = await tx.query(
          "SELECT id FROM exercises WHERE gym_id = ? AND name = ? AND status != 'deleted'",
          [gymId, ex.name],
        );
        if (existing.length > 0) continue;
        const { insertId } = await tx.query(
          `INSERT INTO exercises
            (gym_id, name, min_reps_default, max_reps_default, sets_default, rest_default_seconds, notes_default, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          [gymId, ex.name, ex.min_reps_default, ex.max_reps_default, ex.sets_default, ex.rest_default_seconds, ex.notes_default ?? null],
        );
        for (const key of ex.principal) {
          await tx.query('INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, \'principal\')', [gymId, insertId, key]);
        }
        for (const key of (ex.secondary ?? [])) {
          await tx.query('INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, \'secondary\')', [gymId, insertId, key]);
        }
        count++;
      }
      return count;
    });
    res.json({ inserted });
  } catch (err) { next(err); }
});

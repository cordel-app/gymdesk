import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { MUSCLE_KEYS, normalizeMuscleKey } from '../domain/muscles';

export const platformExercisesRouter = Router();

const SETTABLE_STATUSES = ['active', 'inactive'];

const SELECT = `
  SELECT e.*,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
     FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', rt.id, 'name', rt.name, 'slug', rt.slug))
     FROM exercise_allowed_result_types eart
     JOIN result_types rt ON rt.id = eart.result_type_id
     WHERE eart.exercise_id = e.id ORDER BY rt.id) AS allowed_result_types
  FROM exercises e
`;

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

async function nameTaken(name: string, excludeId?: string | number): Promise<boolean> {
  let sql = "SELECT id FROM exercises WHERE gym_id IS NULL AND name = ? AND status != 'deleted'";
  const params: any[] = [name];
  if (excludeId !== undefined) { sql += ' AND id != ?'; params.push(excludeId); }
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

/* ── List ─────────────────────────────────────────────────────────────────── */

platformExercisesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  const q = req.query.q as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const params: any[] = [];
  let sql = `${SELECT} WHERE e.gym_id IS NULL AND e.status != 'deleted'`;
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  if (q) { sql += ' AND e.name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY e.name ASC';
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Get one ──────────────────────────────────────────────────────────────── */

platformExercisesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE e.id = ? AND e.gym_id IS NULL AND e.status != 'deleted'`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Create ───────────────────────────────────────────────────────────────── */

platformExercisesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  try {
    if (await nameTaken(name.trim())) {
      return res.status(409).json({ error: 'A base exercise with this name already exists.' });
    }
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name.trim(), description ?? null, video_url ?? null, image_url ?? null,
         min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
         sets_default ?? null, notes_default ?? null, status ?? 'active'],
      );
      if (muscles) {
        for (const m of muscles) {
          await tx.query(
            'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, ?, ?)',
            [insertId, m.key, m.role],
          );
        }
      }
      if (allowedResultTypeIds) {
        for (const rtId of allowedResultTypeIds) {
          await tx.query(
            'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
            [insertId, rtId],
          );
        }
      }
      return insertId;
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

platformExercisesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const id = String(req.params.id);
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status,
  } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM exercises WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    if (name?.trim() && await nameTaken(name.trim(), id)) {
      return res.status(409).json({ error: 'A base exercise with this name already exists.' });
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE exercises SET
          name                  = COALESCE(?, name),
          description           = IF(?, ?, description),
          video_url             = IF(?, ?, video_url),
          image_url             = IF(?, ?, image_url),
          min_reps_default      = IF(?, ?, min_reps_default),
          max_reps_default      = IF(?, ?, max_reps_default),
          rest_default_seconds  = IF(?, ?, rest_default_seconds),
          sets_default          = IF(?, ?, sets_default),
          notes_default         = IF(?, ?, notes_default),
          status                = COALESCE(?, status),
          modified_at           = UTC_TIMESTAMP()
         WHERE id = ? AND gym_id IS NULL AND status != 'deleted'`,
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
          id,
        ],
      );
      if (muscles) {
        await tx.query('DELETE FROM exercise_muscles WHERE exercise_id = ? AND gym_id IS NULL', [id]);
        for (const m of muscles) {
          await tx.query(
            'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, ?, ?)',
            [id, m.key, m.role],
          );
        }
      }
      if (allowedResultTypeIds) {
        await tx.query('DELETE FROM exercise_allowed_result_types WHERE exercise_id = ?', [id]);
        for (const rtId of allowedResultTypeIds) {
          await tx.query(
            'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
            [id, rtId],
          );
        }
      }
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ?`, [id]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Soft delete ──────────────────────────────────────────────────────────── */

platformExercisesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      "UPDATE exercises SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [req.params.id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise not found' });
    recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});

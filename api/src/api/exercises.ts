import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/**
 * P5.1 / #55: per-gym exercises + muscles + join. Coach can write;
 * import-defaults seeds a bundled JSON list (skips name duplicates so
 * re-running is safe). Exercise default training values (min/max reps,
 * rest, sets, notes) replaced the old free-text default_reps in #55.
 */

// Small, non-controversial default catalog. Consumers can wire in a larger
// import from a JSON file later; keeping it inline avoids a Docker asset
// copy step in the API image build.
const DEFAULT_MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core'];
const DEFAULT_EXERCISES: Array<{
  name: string; principal: string[]; secondary?: string[];
  min_reps_default: number | null; max_reps_default: number | null;
  sets_default: number; rest_default_seconds: number; notes_default?: string;
}> = [
  { name: 'Bench Press', principal: ['Chest'], secondary: ['Triceps', 'Shoulders'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Squat', principal: ['Quads', 'Glutes'], secondary: ['Hamstrings', 'Core'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 120 },
  { name: 'Deadlift', principal: ['Back', 'Hamstrings'], secondary: ['Glutes', 'Core'], min_reps_default: 5, max_reps_default: 5, sets_default: 3, rest_default_seconds: 150 },
  { name: 'Overhead Press', principal: ['Shoulders'], secondary: ['Triceps', 'Core'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Pull-up', principal: ['Back'], secondary: ['Biceps'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Barbell Row', principal: ['Back'], secondary: ['Biceps', 'Core'], min_reps_default: 8, max_reps_default: 8, sets_default: 4, rest_default_seconds: 90 },
  { name: 'Lunges', principal: ['Quads', 'Glutes'], secondary: ['Hamstrings'], min_reps_default: 12, max_reps_default: 12, sets_default: 3, rest_default_seconds: 60 },
  { name: 'Plank', principal: ['Core'], min_reps_default: null, max_reps_default: null, sets_default: 3, rest_default_seconds: 60, notes_default: '60s hold' },
];

export const musclesRouter = Router();
export const exercisesRouter = Router();

/* ---- Muscles ---- */
musclesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query('SELECT * FROM muscles WHERE gym_id = ? ORDER BY name ASC', [gymId]);
  res.json(rows);
});
musclesRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!req.body.name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const { insertId } = await db.query('INSERT INTO muscles (gym_id, name) VALUES (?, ?)', [gymId, req.body.name.trim()]);
    const { rows } = await db.query('SELECT * FROM muscles WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'muscle', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Muscle already exists.' });
    next(e);
  }
});
musclesRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM muscles WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Muscle not found' });
  recordAudit(req, { action: 'delete', entityType: 'muscle', entityId: req.params.id });
  res.status(204).send();
});

/* ---- Exercises ---- */
const SELECT = `
  SELECT e.*,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', m.id, 'name', m.name, 'role', em.role))
     FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
     WHERE em.exercise_id = e.id) AS muscles
  FROM exercises e
`;

exercisesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE e.gym_id = ?`;
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  sql += ' ORDER BY e.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

exercisesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
  res.json(rows[0]);
});

exercisesRouter.post('/', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
    status, muscle_ids,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
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
      if (Array.isArray(muscle_ids)) {
        for (const m of muscle_ids) {
          if (!m.id) continue;
          await tx.query(
            'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle_id, role) VALUES (?, ?, ?, ?)',
            [gymId, insertId, m.id, m.role === 'secondary' ? 'secondary' : 'principal'],
          );
        }
      }
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
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
    status, muscle_ids,
  } = req.body;
  try {
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
         WHERE id = ? AND gym_id = ?`,
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
          req.params.id, gymId,
        ],
      );
      if (rowCount === 0) throw Object.assign(new Error('Exercise not found'), { status: 404 });

      if (Array.isArray(muscle_ids)) {
        await tx.query('DELETE FROM exercise_muscles WHERE exercise_id = ? AND gym_id = ?', [req.params.id, gymId]);
        for (const m of muscle_ids) {
          if (!m.id) continue;
          await tx.query(
            'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle_id, role) VALUES (?, ?, ?, ?)',
            [gymId, req.params.id, m.id, m.role === 'secondary' ? 'secondary' : 'principal'],
          );
        }
      }
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: req.params.id, next: rows[0] });
    res.json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Exercise with this name already exists.' });
    next(e);
  }
});

exercisesRouter.delete('/:id', requireRole('admin', 'coach'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM exercises WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise not found' });
  recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
  res.status(204).send();
});

/** Idempotent seed of the default muscle + exercise catalog. */
exercisesRouter.post('/import-defaults', requireRole('admin', 'coach'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const inserted = await db.transaction(async (tx) => {
      const muscleIds = new Map<string, number>();
      // Seed muscles (INSERT IGNORE handles the "already there" case)
      for (const m of DEFAULT_MUSCLES) {
        await tx.query('INSERT IGNORE INTO muscles (gym_id, name) VALUES (?, ?)', [gymId, m]);
      }
      const { rows: mRows } = await tx.query('SELECT id, name FROM muscles WHERE gym_id = ?', [gymId]);
      for (const r of mRows) muscleIds.set(r.name, r.id);

      let count = 0;
      for (const ex of DEFAULT_EXERCISES) {
        // Skip if the gym already has an exercise with this name.
        const { rows: existing } = await tx.query('SELECT id FROM exercises WHERE gym_id = ? AND name = ?', [gymId, ex.name]);
        if (existing.length > 0) continue;
        const { insertId } = await tx.query(
          `INSERT INTO exercises
            (gym_id, name, min_reps_default, max_reps_default, sets_default, rest_default_seconds, notes_default, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          [gymId, ex.name, ex.min_reps_default, ex.max_reps_default, ex.sets_default, ex.rest_default_seconds, ex.notes_default ?? null],
        );
        for (const mn of ex.principal) {
          const mid = muscleIds.get(mn);
          if (mid) await tx.query('INSERT INTO exercise_muscles (gym_id, exercise_id, muscle_id, role) VALUES (?, ?, ?, \'principal\')', [gymId, insertId, mid]);
        }
        for (const mn of (ex.secondary ?? [])) {
          const mid = muscleIds.get(mn);
          if (mid) await tx.query('INSERT INTO exercise_muscles (gym_id, exercise_id, muscle_id, role) VALUES (?, ?, ?, \'secondary\')', [gymId, insertId, mid]);
        }
        count++;
      }
      return count;
    });
    res.json({ inserted });
  } catch (err) { next(err); }
});

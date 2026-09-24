import { Request, Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { MUSCLE_KEYS, normalizeMuscleKey } from '../domain/muscles';
import { getReferences } from '../domain/references';
import { handleDupEntry } from '../infra/db-helpers';

/**
 * P5.1 / #55: per-gym exercises. #62: muscles are a static in-app catalog
 * (see domain/muscles.ts) — links live in exercise_muscles keyed by muscle
 * slug. Exercise delete is a soft delete (status='deleted' + deleted_at);
 * name uniqueness among non-deleted rows is enforced here because the DB
 * unique index was dropped to let deleted names be reused.
 */

const SETTABLE_STATUSES = ['active', 'inactive'];

/**
 * #718: a single Import request may not name an unbounded list of base
 * exercises — the whole thing runs in one transaction, and the bound is what
 * stops a hand-rolled request from holding it open over the entire catalog.
 * "Select all matching" with no filters is the realistic worst case, so the
 * cap sits well above the size of the Base Exercises library.
 */
const MAX_IMPORT_IDS = 500;

export const musclesRouter = Router();
export const exercisesRouter = Router();

/* ---- Muscles: read-only static catalog ---- */
musclesRouter.get('/', (_req, res) => {
  res.json(MUSCLE_KEYS.map((key) => ({ key })));
});

/* ---- Exercises ---- */
const SELECT = `
  SELECT e.*,
    gm_c.name AS created_by_name,
    gm_m.name AS modified_by_name,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
     FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', rt.id, 'name', rt.name, 'slug', rt.slug))
     FROM exercise_allowed_result_types eart
     JOIN result_types rt ON rt.id = eart.result_type_id
     WHERE eart.exercise_id = e.id ORDER BY rt.id) AS allowed_result_types
  FROM exercises e
  LEFT JOIN gym_memberships gm_c ON gm_c.id = e.created_by
  LEFT JOIN gym_memberships gm_m ON gm_m.id = e.modified_by
`;

async function getCallerMembershipId(req: Request): Promise<number | null> {
  const userId = req.auth?.userId;
  if (!userId) return null;
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ? LIMIT 1',
    [gymId, userId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

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

async function replaceAllowedResultTypes(tx: Tx, exerciseId: number | string, ids: number[]) {
  await tx.query('DELETE FROM exercise_allowed_result_types WHERE exercise_id = ?', [exerciseId]);
  for (const rtId of ids) {
    await tx.query(
      'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
      [exerciseId, rtId],
    );
  }
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
  const q = req.query.q as string | undefined;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE (e.gym_id = ? OR e.gym_id IS NULL) AND e.status != 'deleted'`;
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  if (q) { sql += ' AND e.name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY e.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

/**
 * #718: the Base Exercises library as the Import Exercises modal needs it.
 * Gym-facing on purpose — `/platform/exercises` is superadmin-only, and a gym
 * admin importing a base exercise is not a platform administrator. Read-only,
 * and both filters are applied here so the modal never pulls the whole library
 * into the browser to filter it there.
 *
 * `imported_exercise_id` is what marks a row as already imported: the gym's own
 * copy, matched either by provenance (`cloned_from_id`) or by name. The name
 * arm matters — an exercise that reached the gym before this endpoint existed
 * (the retired Import Defaults seed, or one typed by hand) carries no
 * provenance, and offering it again would only produce a duplicate name.
 */
const IMPORTED_COPY_ID = `
  (SELECT MIN(g.id) FROM exercises g
    WHERE g.gym_id = ? AND g.status != 'deleted'
      AND (g.cloned_from_id = e.id OR g.name = e.name))`;

exercisesRouter.get('/base', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const q = req.query.q as string | undefined;
  const muscleParam = req.query.muscle as string | undefined;
  let muscle: string | null = null;
  if (muscleParam) {
    muscle = normalizeMuscleKey(muscleParam);
    if (!muscle) return res.status(400).json({ error: `invalid muscle key: ${JSON.stringify(muscleParam)}` });
  }
  // The `?` inside IMPORTED_COPY_ID sits in the SELECT list, so its gymId binds
  // before the WHERE-clause filters below.
  const params: any[] = [gymId];
  let sql = `
    SELECT e.id, e.name, e.description, e.image_url,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
       FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles,
      ${IMPORTED_COPY_ID} AS imported_exercise_id
    FROM exercises e
    WHERE e.gym_id IS NULL AND e.status = 'active'`;
  if (q) { sql += ' AND e.name LIKE ?'; params.push(`%${q}%`); }
  if (muscle) {
    sql += ' AND EXISTS (SELECT 1 FROM exercise_muscles em2 WHERE em2.exercise_id = e.id AND em2.muscle = ?)';
    params.push(muscle);
  }
  sql += ' ORDER BY e.name ASC';
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

exercisesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE e.id = ? AND (e.gym_id = ? OR e.gym_id IS NULL) AND e.status != 'deleted'`,
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

exercisesRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
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
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  try {
    if (await nameTaken(gymId, name.trim())) {
      return res.status(409).json({ error: 'Exercise with this name already exists.' });
    }
    const callerMemberId = await getCallerMembershipId(req);
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, name.trim(), description ?? null, video_url ?? null, image_url ?? null,
         min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
         sets_default ?? null, notes_default ?? null, status ?? 'active', callerMemberId ?? null],
      );
      if (muscles) await replaceMuscles(tx, gymId, insertId, muscles);
      if (allowedResultTypeIds) await replaceAllowedResultTypes(tx, insertId, allowedResultTypeIds);
      return insertId;
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'Exercise with this name already exists.');
  }
});

exercisesRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = String(req.params.id);
  // Guard: base exercises (gym_id IS NULL) may only be modified via /platform/exercises
  const { rows: ownerCheck } = await db.query('SELECT gym_id FROM exercises WHERE id = ?', [id]);
  if (ownerCheck.length > 0 && ownerCheck[0].gym_id === null) {
    return res.status(403).json({ error: 'Base exercises can only be modified by Cordel administrators.' });
  }
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
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  try {
    if (name?.trim() && await nameTaken(gymId, name.trim(), id)) {
      return res.status(409).json({ error: 'Exercise with this name already exists.' });
    }
    const callerMemberId = await getCallerMembershipId(req);
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
          status                = COALESCE(?, status),
          modified_at           = UTC_TIMESTAMP(),
          modified_by           = ?
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
          callerMemberId ?? null,
          id, gymId,
        ],
      );
      if (rowCount === 0) throw Object.assign(new Error('Exercise not found'), { status: 404 });
      if (muscles) await replaceMuscles(tx, gymId, id, muscles);
      if (allowedResultTypeIds) await replaceAllowedResultTypes(tx, id, allowedResultTypeIds);
    });
    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id = ?`, [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    handleDupEntry(e, res, next, 'Exercise with this name already exists.');
  }
});

exercisesRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, actorName } = getTenantContext(req);
  const { rows: ownerCheck } = await db.query('SELECT gym_id FROM exercises WHERE id = ?', [req.params.id]);
  if (ownerCheck.length > 0 && ownerCheck[0].gym_id === null) {
    return res.status(403).json({ error: 'Base exercises can only be modified by Cordel administrators.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE exercises SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ?, deleted_by_name = ?
      WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
    [callerMemberId ?? null, actorName, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise not found' });
  recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
  res.status(204).send();
});

exercisesRouter.post('/:id/duplicate', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = String(req.params.id);
  try {
    const { rows: orig } = await db.query(
      `${SELECT} WHERE e.id = ? AND e.gym_id = ? AND e.status != 'deleted'`,
      [id, gymId],
    );
    if (orig.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    const src = orig[0];
    const callerMemberId = await getCallerMembershipId(req);
    const copyName = `${src.name} (Copy)`;

    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
           status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [gymId, copyName, src.description, src.video_url, src.image_url,
         src.min_reps_default, src.max_reps_default, src.rest_default_seconds, src.sets_default, src.notes_default,
         callerMemberId ?? null],
      );
      const muscles: { key: string; role: string }[] = Array.isArray(src.muscles) ? src.muscles : [];
      for (const m of muscles) {
        await tx.query(
          'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
          [gymId, insertId, m.key, m.role],
        );
      }
      const rts: { id: number }[] = Array.isArray(src.allowed_result_types) ? src.allowed_result_types : [];
      for (const rt of rts) {
        await tx.query(
          'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
          [insertId, rt.id],
        );
      }
      return insertId;
    });

    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id = ?`, [insertId, gymId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/** Clone a base exercise into the gym's own catalog. */
exercisesRouter.post('/:id/clone', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = String(req.params.id);
  try {
    const { rows: orig } = await db.query(
      `${SELECT} WHERE e.id = ? AND e.gym_id IS NULL AND e.status != 'deleted'`,
      [id],
    );
    if (orig.length === 0) return res.status(404).json({ error: 'Base exercise not found' });
    const src = orig[0];
    const callerMemberId = await getCallerMembershipId(req);
    const copyName = `${src.name} (Copy)`;

    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
           status, created_by, cloned_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [gymId, copyName, src.description, src.video_url, src.image_url,
         src.min_reps_default, src.max_reps_default, src.rest_default_seconds, src.sets_default, src.notes_default,
         callerMemberId ?? null, id],
      );
      const muscles: { key: string; role: string }[] = Array.isArray(src.muscles) ? src.muscles : [];
      for (const m of muscles) {
        await tx.query(
          'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
          [gymId, insertId, m.key, m.role],
        );
      }
      const rts: { id: number }[] = Array.isArray(src.allowed_result_types) ? src.allowed_result_types : [];
      for (const rt of rts) {
        await tx.query(
          'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
          [insertId, rt.id],
        );
      }
      return insertId;
    });

    const { rows } = await db.query(`${SELECT} WHERE e.id = ? AND e.gym_id = ?`, [insertId, gymId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * #718: import selected Base Exercises into the gym's own catalog, in one
 * request. Replaces `POST /import-defaults`, which seeded eight hardcoded
 * names that had nothing to do with the platform's Base Exercises library —
 * the library is the source of truth for what a gym can start from.
 *
 * Each import is the copy `POST /:id/clone` makes — same columns, same
 * `cloned_from_id` provenance — except that it keeps the base exercise's name
 * instead of appending "(Copy)": importing fifty exercises named "… (Copy)" is
 * not what the gym asked for, and the name is free because an exercise the gym
 * already has is skipped instead of copied.
 *
 * Unknown ids are rejected outright (400) rather than silently dropped — a gym
 * exercise's id, another gym's exercise, an inactive or deleted base row and a
 * nonexistent id all fail the same lookup, so none of them can be smuggled into
 * a gym's catalog through this route. Ids the gym already has are *not* an
 * error: the modal hides them, but a concurrent import would otherwise turn a
 * harmless race into a failed batch, so they come back under `skipped`.
 */
exercisesRouter.post('/import', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const raw = req.body?.baseExerciseIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'baseExerciseIds must be a non-empty array of base exercise ids' });
  }
  if (raw.length > MAX_IMPORT_IDS) {
    return res.status(400).json({ error: `baseExerciseIds may not contain more than ${MAX_IMPORT_IDS} ids` });
  }
  const ids: number[] = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: `invalid base exercise id: ${JSON.stringify(value)}` });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  try {
    const marks = ids.map(() => '?').join(',');
    const { rows: baseRows } = await db.query(
      `${SELECT} WHERE e.id IN (${marks}) AND e.gym_id IS NULL AND e.status = 'active'`,
      ids,
    );
    const base = new Map<number, any>(baseRows.map((row: any) => [Number(row.id), row]));
    const invalidIds = ids.filter((id) => !base.has(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        error: 'Some ids are not importable base exercises.',
        invalid_ids: invalidIds,
      });
    }

    const callerMemberId = await getCallerMembershipId(req);
    const { insertedIds, skipped } = await db.transaction(async (tx) => {
      const insertedIds: number[] = [];
      const skipped: { id: number; name: string; reason: string; exercise_id: number }[] = [];
      for (const id of ids) {
        const src = base.get(id);
        const { rows: existing } = await tx.query(
          `SELECT id FROM exercises
            WHERE gym_id = ? AND status != 'deleted' AND (cloned_from_id = ? OR name = ?)
            LIMIT 1`,
          [gymId, id, src.name],
        );
        if (existing.length > 0) {
          skipped.push({ id, name: src.name, reason: 'already_imported', exercise_id: existing[0].id });
          continue;
        }
        const { insertId } = await tx.query(
          `INSERT INTO exercises
            (gym_id, name, description, video_url, image_url,
             min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
             status, created_by, cloned_from_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [gymId, src.name, src.description, src.video_url, src.image_url,
           src.min_reps_default, src.max_reps_default, src.rest_default_seconds, src.sets_default, src.notes_default,
           callerMemberId ?? null, id],
        );
        const muscles: { key: string; role: string }[] = Array.isArray(src.muscles) ? src.muscles : [];
        await replaceMuscles(tx, gymId, insertId, muscles);
        const rts: { id: number }[] = Array.isArray(src.allowed_result_types) ? src.allowed_result_types : [];
        await replaceAllowedResultTypes(tx, insertId, rts.map((rt) => rt.id));
        insertedIds.push(insertId);
      }
      return { insertedIds, skipped };
    });

    let imported: any[] = [];
    if (insertedIds.length > 0) {
      const importedMarks = insertedIds.map(() => '?').join(',');
      const { rows } = await db.query(
        `${SELECT} WHERE e.id IN (${importedMarks}) AND e.gym_id = ? ORDER BY e.name ASC`,
        [...insertedIds, gymId],
      );
      imported = rows;
      for (const row of rows) {
        recordAudit(req, { action: 'create', entityType: 'exercise', entityId: row.id, next: row });
      }
    }
    res.status(201).json({ imported, skipped });
  } catch (err) { next(err); }
});

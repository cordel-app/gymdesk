import { Router } from 'express';
import { effectiveImageUrlSql, effectiveImageThumbnailUrlSql, effectiveVideoPosterSql, effectiveVideoUrlSql } from '../domain/effectiveExerciseImage';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import { createTrainingPlanTx } from './training-plan-creation';
import { localizedExerciseNameSql } from '../domain/exerciseTranslations';
import { getRequestLocale } from '../infra/locale';
import { resolveRequestActor } from '../domain/auditActor';
import { parseNumDaysInput, templateResyncChanges, templateSource } from '../domain/trainingPlanTemplateDays';
import { CascadeImportError, cascadeImportTrainingPlanTemplates, copyTemplateWorkoutsTx, planCascadingImport } from './training-plan-template-cascade';

/**
 * #55: TrainingPlanTemplate (reusable multi-day program) + the ordered
 * training_plan_template_workouts junction to WorkoutTemplate. Cloned into
 * TrainingPlan (see training-plans.ts) on assignment (see member-training-plans.ts).
 */

export const trainingPlanTemplatesRouter = Router();

const STATUSES = ['active', 'inactive', 'draft', 'deleted'];

// GET / list sorting: map the public sort key to a safe column (never interpolate raw input).
const SORT_COLUMNS: Record<string, string> = {
  name: 'tpt.name',
  created_at: 'tpt.created_at',
  status: 'tpt.status',
};
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

const LIST_COLUMNS = `tpt.*,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count`;

/** #3334: every gym row reports a derived `source`, never stored. */
function withSource<T extends { cloned_from_id?: number | null }>(row: T): T & { source: string } {
  return { ...row, source: templateSource(row.cloned_from_id) };
}

async function templateExists(id: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM training_plan_templates WHERE id = ? AND (gym_id = ? OR gym_id IS NULL) AND status != 'deleted'",
    [id, gymId],
  );
  return rows.length > 0;
}

/* ---- TrainingPlanTemplate ---- */

trainingPlanTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  // #1182: created_by is the plain-text actor snapshot, so the filter is its exact text.
  const createdBy = typeof req.query.created_by === 'string' && req.query.created_by !== ''
    ? req.query.created_by : null;
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS ? req.query.sort : 'name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  // limit/offset are validated integers — interpolated because mysql2 prepared
  // statements don't accept placeholders in LIMIT reliably.
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    // #3334: the gym's list holds the gym's own templates only — custom and
    // imported. System templates are read through GET /base and imported.
    const where: string[] = ['tpt.gym_id = ?', "tpt.status != 'deleted'"];
    const params: any[] = [gymId];
    if (status) { where.push('tpt.status = ?'); params.push(status); }
    if (name) { where.push('tpt.name LIKE ?'); params.push(`%${name}%`); }
    if (createdBy !== null) { where.push('tpt.created_by = ?'); params.push(createdBy); }
    const whereSql = where.join(' AND ');

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM training_plan_templates tpt WHERE ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT tpt.*,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count
       FROM training_plan_templates tpt
       WHERE ${whereSql}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows.map(withSource), total: Number(countRows[0].total), limit, offset });
  } catch (err) {
    next(err);
  }
});

/**
 * #3334: the System Training Plan Templates a gym may import, each with the
 * gym's own copy (`imported_template_id`, matched by provenance, else by name —
 * the Exercises import's rule), NULL when the gym has none. Gym-facing, like
 * GET /exercises/base.
 */
trainingPlanTemplatesRouter.get('/base', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  // #3334 stage 2: the Import modal's search box (a substring of the name).
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  try {
    const { rows } = await db.query(
      `SELECT ${LIST_COLUMNS},
              (SELECT g.id FROM training_plan_templates g
                WHERE g.gym_id = ? AND g.status != 'deleted'
                  AND (g.cloned_from_id = tpt.id OR g.name = tpt.name)
                ORDER BY (g.cloned_from_id = tpt.id) DESC, g.id ASC LIMIT 1) AS imported_template_id
         FROM training_plan_templates tpt
        WHERE tpt.gym_id IS NULL AND tpt.status = 'active'${name ? ' AND tpt.name LIKE ?' : ''}
        ORDER BY tpt.name ASC`,
      name ? [gymId, `%${name}%`] : [gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const MAX_IMPORT_IDS = 100;

/** The `baseTemplateIds` body both import routes take, or the 400 message. */
function parseImportIds(raw: unknown): number[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'baseTemplateIds must be a non-empty array';
  if (raw.length > MAX_IMPORT_IDS) return `baseTemplateIds may hold at most ${MAX_IMPORT_IDS} ids`;
  if (!raw.every((v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0)) {
    return 'baseTemplateIds must hold positive integer ids';
  }
  return [...new Set(raw as number[])];
}

/**
 * #3337: the cascading import's preview — the System Training Plan Templates
 * the selection imports (or already has), the Workout Templates it creates or
 * updates and the Base Exercises it imports, each listed once across the whole
 * selection. Writes nothing; POST /import executes this same plan.
 */
trainingPlanTemplatesRouter.post('/import/preview', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const ids = parseImportIds(req.body?.baseTemplateIds);
  if (typeof ids === 'string') return res.status(400).json({ error: ids });
  try {
    res.json(await planCascadingImport(db, gymId, ids, getRequestLocale(req)));
  } catch (err: any) {
    if (err instanceof CascadeImportError) return res.status(400).json({ error: err.message, invalid_ids: err.invalid_ids });
    next(err);
  }
});

/**
 * #3334, cascading since #3337: imports System templates into the gym. Each
 * becomes an `active` gym template under the System name with `cloned_from_id`
 * set and its workouts copied; one the gym already has (by provenance or by
 * name) is reported under `skipped`. In the same transaction the Workout
 * Templates they link to are created or updated, the Base Exercises those name
 * and the gym lacks are imported, and every gym-side link is re-pointed at the
 * gym's own Workout Templates and Exercises (`training-plan-template-cascade.ts`).
 * An id that is not an active System template refuses the whole batch.
 */
trainingPlanTemplatesRouter.post('/import', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const ids = parseImportIds(req.body?.baseTemplateIds);
  if (typeof ids === 'string') return res.status(400).json({ error: ids });
  try {
    const result = await db.transaction((tx) =>
      cascadeImportTrainingPlanTemplates(tx, gymId, ids, getRequestLocale(req), actor));
    for (const id of result.exercises.imported) {
      recordAudit(req, { action: 'create', entityType: 'exercise', entityId: id });
    }
    for (const id of result.workout_templates.created) {
      recordAudit(req, { action: 'create', entityType: 'workout_template', entityId: id });
    }
    for (const id of result.workout_templates.updated) {
      recordAudit(req, { action: 'update', entityType: 'workout_template', entityId: id });
    }
    for (const newId of result.imported) {
      recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: newId });
    }
    res.status(201).json(result);
  } catch (err: any) {
    if (err instanceof CascadeImportError) return res.status(400).json({ error: err.message, invalid_ids: err.invalid_ids });
    next(err);
  }
});

// Distinct authors of this gym's non-deleted templates — populates the Created By filter.
trainingPlanTemplatesRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT tpt.created_by AS name
       FROM training_plan_templates tpt
       WHERE tpt.gym_id = ? AND tpt.status != 'deleted' AND tpt.created_by IS NOT NULL
       ORDER BY tpt.created_by ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    // MySQL's JSON_ARRAYAGG has no ORDER BY of its own — aggregate over a
    // derived table pre-sorted by position instead.
    const { rows } = await db.query(
      `SELECT tpt.*,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', j.id, 'position', j.position, 'scheduled_weekday', j.scheduled_weekday,
              'workout_template_id', j.workout_template_id, 'workout_template_name', wt.name) AS item
          FROM training_plan_template_workouts j JOIN workout_templates wt ON wt.id = j.workout_template_id
          WHERE j.training_plan_template_id = tpt.id
          ORDER BY j.position
        ) t1) AS workouts
       FROM training_plan_templates tpt
       WHERE tpt.id = ? AND (tpt.gym_id = ? OR tpt.gym_id IS NULL) AND tpt.status != 'deleted'`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Full 4-level tree (workouts -> blocks -> exercises) for one template, in a
// single request — the client fetches this on first expand of a template row
// and caches it. Extends the derived-table-per-level JSON_ARRAYAGG pattern used
// by GET /:id here and by workout-templates.ts GET /:id one level deeper.
//
// #966: the result type is the **exercise instance's**, not the block's.
// #154 (migration 074) moved it down a level — it dropped
// workout_template_blocks.result_type and added result_type_id + target/min/max
// + unit to workout_template_exercises — and this query kept selecting
// `b.result_type`, so every expand answered `Unknown column 'b.result_type' in
// 'field list'`. The exercise object below is workout-templates.ts GET /:id's
// own projection, which is what `HierExercise`/`exerciseSummary()` (the shared
// summaries.ts both trees render through) have expected all along.
trainingPlanTemplatesRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      `SELECT tpt.id, tpt.name, tpt.status,
        (SELECT JSON_ARRAYAGG(item) FROM (
          SELECT JSON_OBJECT(
              'id', j.id, 'position', j.position, 'scheduled_weekday', j.scheduled_weekday,
              'workout_template_id', j.workout_template_id, 'workout_template_name', wt.name,
              'blocks', (SELECT JSON_ARRAYAGG(item) FROM (
                SELECT JSON_OBJECT(
                    'id', b.id, 'position', b.position, 'name', b.name, 'description', b.description,
                    'type', b.type, 'rounds', b.rounds,
                    'duration_seconds', b.duration_seconds, 'work_seconds', b.work_seconds, 'rest_seconds', b.rest_seconds,
                    'is_optional', b.is_optional, 'notes', b.notes, 'result_unit', b.result_unit,
                    'exercises', (SELECT JSON_ARRAYAGG(item) FROM (
                      SELECT JSON_OBJECT(
                          'id', wte.id, 'position', wte.position, 'exercise_id', COALESCE(wte.base_exercise_id, wte.exercise_id),
                          'exercise_name', ${localizedExerciseNameSql('e', getRequestLocale(req))},
                          'exercise_image_url', ${effectiveImageUrlSql('e')}, 'exercise_image_thumbnail_url', ${effectiveImageThumbnailUrlSql('e')}, 'exercise_video_url', ${effectiveVideoUrlSql('e')}, 'exercise_video_thumbnail_url', ${effectiveVideoPosterSql('e')},
                          'min_reps', wte.min_reps, 'max_reps', wte.max_reps,
                          'sets', wte.sets, 'rest_seconds', wte.rest_seconds, 'tempo', wte.tempo,
                          'result_type_id', wte.result_type_id, 'result_type_slug', rt.slug, 'result_type_name', rt.name,
                          'target_value', wte.target_value, 'min_value', wte.min_value, 'max_value', wte.max_value,
                          'unit', wte.unit) AS item
                      FROM workout_template_exercises wte
                      JOIN exercise_catalogue e ON e.id = COALESCE(wte.base_exercise_id, wte.exercise_id)
                      LEFT JOIN result_types rt ON rt.id = wte.result_type_id
                      WHERE wte.workout_template_block_id = b.id AND wte.deleted_at IS NULL
                      ORDER BY wte.position
                    ) t3)
                  ) AS item
                FROM workout_template_blocks b WHERE b.workout_template_id = wt.id AND b.deleted_at IS NULL
                ORDER BY b.position
              ) t2)
            ) AS item
          FROM training_plan_template_workouts j JOIN workout_templates wt ON wt.id = j.workout_template_id
          WHERE j.training_plan_template_id = tpt.id
          ORDER BY j.position
        ) t1) AS workouts
       FROM training_plan_templates tpt WHERE tpt.id = ? AND (tpt.gym_id = ? OR tpt.gym_id IS NULL) AND tpt.status != 'deleted'`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const numDays = parseNumDaysInput(req.body);
  if (numDays.kind === 'error') return res.status(400).json({ error: numDays.error });
  try {
    const row = await insertAndFetch(
      'INSERT INTO training_plan_templates (gym_id, name, description, num_days, status, created_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)',
      [gymId, name.trim(), description ?? null, numDays.kind === 'value' ? numDays.value : 0, status ?? 'active', actor, actor],
      'SELECT * FROM training_plan_templates WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

trainingPlanTemplatesRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  const { rows: ownerCheck } = await db.query('SELECT gym_id FROM training_plan_templates WHERE id = ?', [id]);
  if (ownerCheck.length > 0 && ownerCheck[0].gym_id === null) {
    return res.status(403).json({ error: 'Base training plan templates can only be modified by Cordel administrators.' });
  }
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const numDays = parseNumDaysInput(req.body);
  if (numDays.kind === 'error') return res.status(400).json({ error: numDays.error });
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_templates SET
        name = COALESCE(?, name), description = IF(?, ?, description), status = COALESCE(?, status),
        num_days = IF(?, ?, num_days),
        modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null,
        numDays.kind === 'value' ? 1 : 0, numDays.kind === 'value' ? numDays.value : 0, actor, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Training plan template not found' });
    const { rows } = await db.query('SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ?', [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'training_plan_template', entityId: id, next: rows[0] });
    res.json(withSource(rows[0]));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

trainingPlanTemplatesRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  const { rows: ownerCheck } = await db.query('SELECT gym_id FROM training_plan_templates WHERE id = ?', [id]);
  if (ownerCheck.length > 0 && ownerCheck[0].gym_id === null) {
    return res.status(403).json({ error: 'Base training plan templates can only be modified by Cordel administrators.' });
  }
  const { rowCount } = await db.query(
    "UPDATE training_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [actor, id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Training plan template not found' });
  recordAudit(req, { action: 'delete', entityType: 'training_plan_template', entityId: id });
  res.status(204).send();
});

trainingPlanTemplatesRouter.post('/:id/duplicate', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    const { rows: srcRows } = await db.query(
      "SELECT * FROM training_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    const src = srcRows[0];

    let copyName = `${src.name} (Copy)`;
    // Avoid unique-name conflicts by appending a suffix when needed.
    const { rows: existing } = await db.query(
      'SELECT name FROM training_plan_templates WHERE gym_id = ? AND name LIKE ?',
      [gymId, `${src.name} (Copy%`],
    );
    if (existing.length > 0) {
      copyName = `${src.name} (Copy ${existing.length + 1})`;
    }

    const newId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO training_plan_templates (gym_id, name, description, num_days, status, created_by, modified_at, modified_by, cloned_from_id) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)',
        [gymId, copyName, src.description ?? null, src.num_days ?? 0, 'draft', actor, actor, null],
      );
      await copyTemplateWorkoutsTx(tx, gymId, id, insertId);
      return insertId;
    });

    const { rows: newRows } = await db.query(
      `SELECT tpt.*,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count
       FROM training_plan_templates tpt
       WHERE tpt.id = ?`,
      [newId],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: newId, next: newRows[0] });
    res.status(201).json(withSource(newRows[0]));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

/** Clone a base training plan template into the gym's own catalog. */
trainingPlanTemplatesRouter.post('/:id/clone', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    const { rows: srcRows } = await db.query(
      "SELECT * FROM training_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Base training plan template not found' });
    const src = srcRows[0];

    const copyName = `${src.name} (Copy)`;

    const newId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO training_plan_templates (gym_id, name, description, num_days, status, created_by, modified_at, modified_by, cloned_from_id) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)',
        [gymId, copyName, src.description ?? null, src.num_days ?? 0, 'draft', actor, actor, id],
      );
      await copyTemplateWorkoutsTx(tx, gymId, id, insertId);
      return insertId;
    });

    const { rows: newRows } = await db.query(
      `SELECT tpt.*,
              (SELECT COUNT(*) FROM training_plan_template_workouts WHERE training_plan_template_id = tpt.id) AS workout_count
       FROM training_plan_templates tpt
       WHERE tpt.id = ?`,
      [newId],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template', entityId: newId, next: newRows[0] });
    res.status(201).json(withSource(newRows[0]));
  } catch (err) { next(err); }
});

/**
 * #3334: "Resync with System", as the Exercises resync (#2302): the System
 * template's name, description and num_days move onto the gym's copy. The
 * copy's workouts are the gym's own once imported and are never replaced.
 */
trainingPlanTemplatesRouter.post('/:id/resync-with-system', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { id } = req.params as { id: string };
  try {
    const { rows: own } = await db.query(
      "SELECT id, name, description, num_days, cloned_from_id FROM training_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (own.length === 0) return res.status(404).json({ error: 'Training plan template not found' });
    const copy = own[0];
    if (copy.cloned_from_id == null) {
      return res.status(400).json({ code: 'no_base_template', error: 'This template was not imported from the System catalogue.' });
    }
    const { rows: baseRows } = await db.query(
      "SELECT id, name, description, num_days FROM training_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [copy.cloned_from_id],
    );
    if (baseRows.length === 0) {
      return res.status(409).json({ code: 'base_unavailable', error: 'The originating System template no longer exists.' });
    }
    const base = baseRows[0];
    const changed = templateResyncChanges(copy, base);
    if (changed.length === 0) return res.json({ updated: [], message: 'up_to_date' });
    if (changed.includes('name')) {
      const { rows: taken } = await db.query(
        "SELECT id FROM training_plan_templates WHERE gym_id = ? AND status != 'deleted' AND name = ? AND id <> ? LIMIT 1",
        [gymId, base.name, copy.id],
      );
      if (taken.length > 0) {
        return res.status(409).json({ code: 'name_taken', error: 'Another template in this gym already uses the System name.' });
      }
    }
    const actor = resolveRequestActor(ctx);
    await db.query(
      `UPDATE training_plan_templates SET name = ?, description = ?, num_days = ?,
              modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [base.name, base.description ?? null, base.num_days, actor, copy.id, gymId],
    );
    const { rows } = await db.query(`SELECT ${LIST_COLUMNS} FROM training_plan_templates tpt WHERE tpt.id = ?`, [copy.id]);
    recordAudit(req, { action: 'update', entityType: 'training_plan_template', entityId: copy.id, previous: copy, next: rows[0] });
    res.json({ updated: changed, template: withSource(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** Assign a training plan template (gym-owned or base) to a member. */
trainingPlanTemplatesRouter.post('/:id/assign', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId, gymMembershipId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { member_id, name, description, start_date, valid_to, confirm } = req.body;
  const { id } = req.params as { id: string };
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });
  try {
    const result = await db.transaction(async (tx) => {
      return createTrainingPlanTx(tx, {
        gymId,
        memberId: member_id,
        gymMembershipId,
        actor,
        templateId: Number(id),
        name: name ?? null,
        description: description ?? null,
        startDate: start_date ?? null,
        validTo: valid_to ?? null,
        confirmReplace: confirm === true,
      });
    });
    for (const sid of result.supersededIds) {
      recordAudit(req, { action: 'status_change', entityType: 'training_plan', entityId: sid,
        previous: { status: 'active' }, next: { status: 'completed', replaced_by: result.planId } });
    }
    res.status(201).json({ id: result.planId, member_id, mtp_id: result.mtpId, name: result.planName });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json(err.code ? { error: err.message, code: err.code, current_plan: err.current_plan } : { error: err.message });
    next(err);
  }
});

/* ---- TrainingPlanTemplateWorkout (junction) ---- */

trainingPlanTemplatesRouter.get('/:id/workouts', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? AND j.gym_id = ? ORDER BY j.position ASC`,
      [id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.post('/:id/workouts', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
  const workoutTemplateId = Number(req.body.workout_template_id);
  if (!Number.isInteger(workoutTemplateId) || workoutTemplateId <= 0) {
    return res.status(400).json({ error: 'workout_template_id is required' });
  }
  const scheduledWeekday = req.body.scheduled_weekday == null || req.body.scheduled_weekday === ''
    ? null : Number(req.body.scheduled_weekday);
  if (scheduledWeekday !== null && (scheduledWeekday < 0 || scheduledWeekday > 6)) {
    return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  }
  try {
    const { rows: wtRows } = await db.query(
      'SELECT 1 FROM workout_templates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [workoutTemplateId, gymId],
    );
    if (wtRows.length === 0) return res.status(400).json({ error: 'workout_template_id does not belong to this gym' });

    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM training_plan_template_workouts WHERE training_plan_template_id = ?',
      [id],
    );
    const row = await insertAndFetch(
      `INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday)
       VALUES (?, ?, ?, ?, ?)`,
      [gymId, id, workoutTemplateId, posRows[0].next_position, scheduledWeekday],
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id WHERE j.id = ?`,
      (linkId) => [linkId],
    );
    recordAudit(req, { action: 'create', entityType: 'training_plan_template_workout', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.put('/:id/workouts/reorder', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of junction-row ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'training_plan_template_workouts', 'training_plan_template_id', id, order));
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id
       WHERE j.training_plan_template_id = ? AND j.gym_id = ? ORDER BY j.position ASC`,
      [id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.put('/:id/workouts/:linkId', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, linkId } = req.params as { id: string; linkId: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Training plan template not found' });
  const scheduledWeekday = req.body.scheduled_weekday == null || req.body.scheduled_weekday === ''
    ? null : Number(req.body.scheduled_weekday);
  if (scheduledWeekday !== null && (scheduledWeekday < 0 || scheduledWeekday > 6)) {
    return res.status(400).json({ error: 'scheduled_weekday must be between 0 and 6' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE training_plan_template_workouts SET scheduled_weekday = ?
       WHERE id = ? AND training_plan_template_id = ? AND gym_id = ?`,
      [scheduledWeekday, linkId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Link not found' });
    const { rows } = await db.query(
      `SELECT j.*, wt.name AS workout_template_name FROM training_plan_template_workouts j
       JOIN workout_templates wt ON wt.id = j.workout_template_id WHERE j.id = ?`,
      [linkId],
    );
    recordAudit(req, { action: 'update', entityType: 'training_plan_template_workout', entityId: linkId, next: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

trainingPlanTemplatesRouter.delete('/:id/workouts/:linkId', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { id, linkId } = req.params as { id: string; linkId: string };
  const { rowCount } = await db.query(
    'DELETE FROM training_plan_template_workouts WHERE id = ? AND training_plan_template_id = ? AND gym_id = ?',
    [linkId, id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Link not found' });
  recordAudit(req, { action: 'delete', entityType: 'training_plan_template_workout', entityId: linkId });
  res.status(204).send();
});

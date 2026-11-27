import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { BASE_MEAL_JOIN_SQL, baseMealColumnsSql, listBaseMealsHandler, resolveBaseMealInput } from './base-meal-reference';
import { goalRowsSql, parseGoalIllustrationInput, validateGoalIllustration } from './nutrition-goal-illustration';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import { createNutritionPlanTx } from './nutrition-plan-creation';
import { copyTemplateContentTx } from './nutrition-plan-template-copy';
import { nutritionPlanTemplateEditSessionRouter } from './nutrition-plan-template-edit-session';
import { parseNumDaysInput, templateResyncChanges } from '../domain/nutritionPlanTemplateDays';
import { memberNotesSetParams, parseMemberNotesInput } from '../domain/nutritionPlanMemberNotes';
import { localizedNameExpr } from '../domain/nutritionLibrary';
import { getRequestLocale, SupportedLocale } from '../infra/locale';
import { resolveRequestActor } from '../domain/auditActor';
import { TEMPLATE_COMPONENT_TYPES, isComponentType } from '../domain/nutritionComponentTypes';

export const nutritionPlanTemplatesRouter = Router();

// #3482: Edit mode's checkpoint (start, Cancel restores, Save drops).
nutritionPlanTemplatesRouter.use(nutritionPlanTemplateEditSessionRouter);

const STATUSES = ['active', 'inactive', 'draft', 'deleted'];
const SORT_COLUMNS: Record<string, string> = {
  name: 'npt.name',
  created_at: 'npt.created_at',
  status: 'npt.status',
};
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// weekday 0-6 = Mon-Sun, 7 = All Days
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6, 7];

const COMPONENT_TYPES = TEMPLATE_COMPONENT_TYPES;

const MAX_IMPORT_IDS = 100;

/**
 * #3333: where a gym template came from — `system` when its `cloned_from_id`
 * names a System template (gym_id IS NULL), else `custom` (created by the gym,
 * or a Clone/Duplicate of one of its own). Derived from provenance, never stored.
 */
const SOURCE_COLUMNS_SQL = `IF(EXISTS(SELECT 1 FROM nutrition_plan_templates src
                                      WHERE src.id = npt.cloned_from_id AND src.gym_id IS NULL),
                               'system', 'custom') AS source`;

/** The gym's live copy of the System template `npt` (binds the gym id). */
const IMPORTED_COPY_SQL = `(SELECT c.id FROM nutrition_plan_templates c
                             WHERE c.gym_id = ? AND c.status != 'deleted'
                               AND (c.cloned_from_id = npt.id OR c.name = npt.name)
                             ORDER BY c.id ASC LIMIT 1)`;

const NUTRITION_GOALS = [
  'protein', 'water', 'calories', 'carbohydrates', 'fats', 'fiber',
  'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
  'performance', 'recovery', 'energy',
] as const;

/* ---- helpers ---- */

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string | number, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

async function templateExists(id: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM nutrition_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [id, gymId],
  );
  return rows.length > 0;
}

async function dayExists(templateId: string, dayId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM nutrition_plan_template_days WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?',
    [dayId, templateId, gymId],
  );
  return rows.length > 0;
}

async function mealExists(dayId: string, mealId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM nutrition_plan_template_meals WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id = ?',
    [mealId, dayId, gymId],
  );
  return rows.length > 0;
}

async function libraryItemExists(id: number): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM nutrition_library_item_catalogue WHERE id = ?', [id]);
  return rows.length > 0;
}

// #3328 stage 2: a meal reports its Base Meal (name, description, image) beside its own fields.
const mealSelect = (locale: SupportedLocale) => `
  SELECT m.id, m.gym_id, m.nutrition_plan_template_day_id,
         m.meal_type, m.display_name, m.notes, m.position,
         ${baseMealColumnsSql(locale)}
  FROM nutrition_plan_template_meals m
  ${BASE_MEAL_JOIN_SQL}
`;

async function fetchMealWithItems(mealId: string | number, locale: SupportedLocale) {
  const { rows: mealRows } = await db.query(
    `${mealSelect(locale)} WHERE m.id = ?`,
    [mealId],
  );
  if (mealRows.length === 0) return null;
  const meal = mealRows[0];
  const { rows: items } = await db.query(
    `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', locale)},
            i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
     FROM nutrition_plan_template_meal_items i
     JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
     WHERE i.meal_id = ?
     ORDER BY i.position ASC`,
    [mealId],
  );
  return { ...meal, items };
}

/* ---- Templates ---- */

/* ── Food Type (component_type) options ──────────────────────────────────── */
// #812: the set this surface accepts, served from the same constant the write
// routes validate against — so the admin's Food Type selector cannot offer a
// value the CHECK would refuse, and does not carry a second copy of the set.
// Registered before `/:id`, or Express reads `component-types` as an id.

// #3328 stage 2: the Base Meals a meal may be (the picker's list). Before `/:id`.
nutritionPlanTemplatesRouter.get('/base-meals', listBaseMealsHandler);

nutritionPlanTemplatesRouter.get('/component-types', (_req, res) => {
  res.json({ component_types: COMPONENT_TYPES });
});

nutritionPlanTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  // ?type=base|gym filters by owner; default returns both
  const type = req.query.type as 'base' | 'gym' | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  // #1182: created_by is the plain-text actor snapshot, so the filter is its exact text.
  const createdBy = typeof req.query.created_by === 'string' && req.query.created_by !== ''
    ? req.query.created_by : null;
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS ? req.query.sort : 'name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    // #3333: the gym's list is its own templates (custom and imported) only;
    // a System template reaches the gym by import. `type=base` still reads the
    // System catalogue for a caller that asks for it explicitly.
    const scopeClause = type === 'base' ? 'npt.gym_id IS NULL' : 'npt.gym_id = ?';
    const scopeParams: any[] = type === 'base' ? [] : [gymId];

    const where: string[] = [scopeClause, "npt.status != 'deleted'"];
    const params: any[] = [...scopeParams];
    if (status) { where.push('npt.status = ?'); params.push(status); }
    if (name) { where.push('npt.name LIKE ?'); params.push(`%${name}%`); }
    if (createdBy !== null) { where.push('npt.created_by = ?'); params.push(createdBy); }
    const whereSql = where.join(' AND ');

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM nutrition_plan_templates npt WHERE ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT npt.*,
              IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count,
              ${SOURCE_COLUMNS_SQL}
       FROM nutrition_plan_templates npt
       WHERE ${whereSql}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT npt.created_by AS name
       FROM nutrition_plan_templates npt
       WHERE npt.gym_id = ? AND npt.status != 'deleted' AND npt.created_by IS NOT NULL
       ORDER BY npt.created_by ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * #3333: the System Nutrition Plan Templates a gym may import, each with the
 * gym's live copy of it (`imported_template_id`, NULL when not imported). A copy
 * is recognised by its provenance (`cloned_from_id`) or, for a template copied
 * before provenance existed, by its name — the same rule `POST /import` skips on.
 * Gym-facing on purpose (`/platform/*` is superadmin-only), as `GET /exercises/base`.
 */
nutritionPlanTemplatesRouter.get('/base', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  try {
    const params: any[] = [gymId];
    let nameSql = '';
    if (name) { nameSql = ' AND npt.name LIKE ?'; params.push(`%${name}%`); }
    const { rows } = await db.query(
      `SELECT npt.id, npt.name, npt.description, npt.num_days, npt.status, npt.created_at,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count,
              ${IMPORTED_COPY_SQL} AS imported_template_id
         FROM nutrition_plan_templates npt
        WHERE npt.gym_id IS NULL AND npt.status = 'active'${nameSql}
        ORDER BY npt.name ASC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * #3333: import selected System templates into the gym, in one request — the
 * Exercises' import (#718) for Nutrition Plan Templates. Each import is a deep
 * copy (`copyTemplateContentTx()`, the copy Clone and Duplicate make) that keeps
 * the System name, records `cloned_from_id` and is `active`. An id that is not an
 * active System template is a 400 for the whole batch; an id the gym already has
 * a copy of comes back under `skipped`.
 */
nutritionPlanTemplatesRouter.post('/import', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const raw = req.body?.baseTemplateIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'baseTemplateIds must be a non-empty array of base template ids' });
  }
  if (raw.length > MAX_IMPORT_IDS) {
    return res.status(400).json({ error: `baseTemplateIds may not contain more than ${MAX_IMPORT_IDS} ids` });
  }
  const ids: number[] = [];
  for (const value of raw) {
    const id = Number(value);
    if (typeof value === 'boolean' || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: `invalid base template id: ${JSON.stringify(value)}` });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  try {
    const marks = ids.map(() => '?').join(',');
    const { rows: baseRows } = await db.query(
      `SELECT * FROM nutrition_plan_templates WHERE id IN (${marks}) AND gym_id IS NULL AND status = 'active'`,
      ids,
    );
    const base = new Map<number, any>(baseRows.map((row: any) => [Number(row.id), row]));
    const invalidIds = ids.filter((id) => !base.has(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: 'Some ids are not importable base templates.', invalid_ids: invalidIds });
    }

    const actor = resolveRequestActor(ctx);
    const { insertedIds, skipped } = await db.transaction(async (tx) => {
      const insertedIds: number[] = [];
      const skipped: { id: number; name: string; reason: string; template_id: number }[] = [];
      for (const id of ids) {
        const src = base.get(id);
        const { rows: existing } = await tx.query(
          `SELECT id FROM nutrition_plan_templates
            WHERE gym_id = ? AND status != 'deleted' AND (cloned_from_id = ? OR name = ?)
            ORDER BY id ASC LIMIT 1`,
          [gymId, id, src.name],
        );
        if (existing.length > 0) {
          skipped.push({ id, name: src.name, reason: 'already_imported', template_id: Number(existing[0].id) });
          continue;
        }
        const { insertId } = await tx.query(
          `INSERT INTO nutrition_plan_templates
             (gym_id, name, description, member_notes, num_days, status, created_by, modified_at, modified_by, cloned_from_id)
           VALUES (?, ?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), ?, ?)`,
          [gymId, src.name, src.description ?? null, src.member_notes ?? null, src.num_days ?? 0, actor, actor, id],
        );
        await copyTemplateContentTx(tx, id, insertId, gymId);
        insertedIds.push(insertId);
      }
      return { insertedIds, skipped };
    });

    let imported: any[] = [];
    if (insertedIds.length > 0) {
      const { rows } = await db.query(
        `SELECT npt.*, IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type,
                (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count,
                ${SOURCE_COLUMNS_SQL}
           FROM nutrition_plan_templates npt
          WHERE npt.id IN (${insertedIds.map(() => '?').join(',')}) AND npt.gym_id = ?
          ORDER BY npt.name ASC`,
        [...insertedIds, gymId],
      );
      imported = rows;
      for (const row of rows) {
        recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: row.id, next: row });
      }
    }
    res.status(insertedIds.length > 0 ? 201 : 200).json({ imported, skipped });
  } catch (err) { next(err); }
});

/**
 * #3333: "Resync with System" — the Exercises' #2302 for a Nutrition Plan
 * Template. Moves the System template's name, description and `num_days` onto
 * the gym's imported copy (`templateResyncChanges()` decides which differ). The
 * copy's content — days, meals, restrictions, goals — is the gym's own once
 * imported and is never replaced, so a resync cannot discard what the gym edited.
 */
nutritionPlanTemplatesRouter.post('/:id/resync-with-system', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const { rows: own } = await db.query(
      `SELECT npt.id, npt.name, npt.description, npt.num_days, npt.cloned_from_id,
              (SELECT src.gym_id IS NULL FROM nutrition_plan_templates src WHERE src.id = npt.cloned_from_id) AS from_system
         FROM nutrition_plan_templates npt
        WHERE npt.id = ? AND npt.gym_id = ? AND npt.status != 'deleted'`,
      [req.params.id, gymId],
    );
    if (own.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const copy = own[0];
    if (!copy.cloned_from_id || Number(copy.from_system) !== 1) {
      return res.status(400).json({ code: 'no_base_template', error: 'This template was not imported from the System catalogue.' });
    }
    const { rows: baseRows } = await db.query(
      "SELECT id, name, description, num_days FROM nutrition_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
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
        "SELECT id FROM nutrition_plan_templates WHERE gym_id = ? AND status != 'deleted' AND name = ? AND id <> ? LIMIT 1",
        [gymId, base.name, copy.id],
      );
      if (taken.length > 0) {
        return res.status(409).json({ code: 'name_taken', error: 'Another template in this gym already uses the System name.' });
      }
    }
    await db.query(
      `UPDATE nutrition_plan_templates
          SET name = ?, description = ?, num_days = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [base.name, base.description ?? null, base.num_days ?? 0, resolveRequestActor(ctx), copy.id, gymId],
    );
    recordAudit(req, {
      action: 'update',
      entityType: 'nutrition_plan_template',
      entityId: copy.id,
      next: { resync_with_system: changed },
    });
    const { rows } = await db.query(
      `SELECT npt.*, IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count,
              ${SOURCE_COLUMNS_SQL}
         FROM nutrition_plan_templates npt WHERE npt.id = ? AND npt.gym_id = ?`,
      [copy.id, gymId],
    );
    res.json({ updated: changed, template: rows[0] ?? null });
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT npt.*, IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type, ${SOURCE_COLUMNS_SQL}
       FROM nutrition_plan_templates npt
       WHERE npt.id = ? AND (npt.gym_id = ? OR npt.gym_id IS NULL) AND npt.status != 'deleted'`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Full hierarchy: template → days → meals (with items[]) + restrictions + goals
nutritionPlanTemplatesRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows: tplRows } = await db.query(
      "SELECT id, name, status, IF(gym_id IS NULL, 'base', 'gym') AS owner_type FROM nutrition_plan_templates WHERE id = ? AND (gym_id = ? OR gym_id IS NULL) AND status != 'deleted'",
      [id, gymId],
    );
    if (tplRows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });

    const gymIdFilter = tplRows[0].owner_type === 'base' ? null : gymId;
    const { rows: dayRows } = await db.query(
      gymIdFilter
        ? 'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC'
        : 'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      gymIdFilter ? [id, gymIdFilter] : [id],
    );
    const days = await Promise.all(dayRows.map(async (day: any) => {
      const { rows: mealRows } = await db.query(
        gymIdFilter
          ? `${mealSelect(getRequestLocale(req))} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ? ORDER BY m.position ASC`
          : `${mealSelect(getRequestLocale(req))} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id IS NULL ORDER BY m.position ASC`,
        gymIdFilter ? [day.id, gymIdFilter] : [day.id],
      );
      const meals = await Promise.all(mealRows.map(async (meal: any) => {
        const { rows: items } = await db.query(
          `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
                  i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
           FROM nutrition_plan_template_meal_items i
           JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
           WHERE i.meal_id = ?
           ORDER BY i.position ASC`,
          [meal.id],
        );
        return { ...meal, items };
      }));
      return { ...day, meals };
    }));

    const { rows: restrictionRows } = await db.query(
      gymIdFilter
        ? `SELECT r.*, COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))}, (SELECT GROUP_CONCAT(nlc.slug ORDER BY nlc.id SEPARATOR ', ') FROM nutrition_library_item_category_catalogue nlic JOIN nutrition_library_categories nlc ON nlc.id = nlic.category_id WHERE nlic.item_id = nli.id) AS item_category, nli.image_url AS item_image_url
           FROM nutrition_plan_template_restrictions r
           JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id)
           WHERE r.nutrition_plan_template_id = ? AND r.gym_id = ?
           ORDER BY r.position ASC`
        : `SELECT r.*, COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))}, (SELECT GROUP_CONCAT(nlc.slug ORDER BY nlc.id SEPARATOR ', ') FROM nutrition_library_item_category_catalogue nlic JOIN nutrition_library_categories nlc ON nlc.id = nlic.category_id WHERE nlic.item_id = nli.id) AS item_category, nli.image_url AS item_image_url
           FROM nutrition_plan_template_restrictions r
           JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id)
           WHERE r.nutrition_plan_template_id = ? AND r.gym_id IS NULL
           ORDER BY r.position ASC`,
      gymIdFilter ? [id, gymIdFilter] : [id],
    );

    const { rows: goalRows } = await db.query(
      gymIdFilter
        ? goalRowsSql('nutrition_plan_template_goals', 'g.nutrition_plan_template_id = ? AND g.gym_id = ?', getRequestLocale(req))
        : goalRowsSql('nutrition_plan_template_goals', 'g.nutrition_plan_template_id = ? AND g.gym_id IS NULL', getRequestLocale(req)),
      gymIdFilter ? [id, gymIdFilter] : [id],
    );

    res.json({ ...tplRows[0], days, restrictions: restrictionRows, goals: goalRows });
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const numDays = parseNumDaysInput(req.body);
  if (numDays.kind === 'error') return res.status(400).json({ error: numDays.error });
  const memberNotes = parseMemberNotesInput(req.body);
  if (memberNotes.kind === 'error') return res.status(400).json({ error: memberNotes.error });
  try {
    const row = await insertAndFetch(
      'INSERT INTO nutrition_plan_templates (gym_id, name, description, member_notes, num_days, status, created_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)',
      [gymId, name.trim(), description ?? null, memberNotes.kind === 'value' ? memberNotes.value : null, numDays.kind === 'value' ? numDays.value : 0, status ?? 'active', actor, actor],
      'SELECT * FROM nutrition_plan_templates WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

nutritionPlanTemplatesRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const numDays = parseNumDaysInput(req.body);
  if (numDays.kind === 'error') return res.status(400).json({ error: numDays.error });
  const memberNotes = parseMemberNotesInput(req.body);
  if (memberNotes.kind === 'error') return res.status(400).json({ error: memberNotes.error });
  try {
    const { rowCount } = await db.query(
      `UPDATE nutrition_plan_templates SET
        name = COALESCE(?, name), description = IF(?, ?, description), member_notes = IF(?, ?, member_notes),
        status = COALESCE(?, status),
        num_days = IF(?, ?, num_days),
        modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, ...memberNotesSetParams(memberNotes),
       status ?? null,
       numDays.kind === 'value' ? 1 : 0, numDays.kind === 'value' ? numDays.value : 0, actor, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const { rows } = await db.query(
      `SELECT npt.*
       FROM nutrition_plan_templates npt
       WHERE npt.id = ? AND npt.gym_id = ?`,
      [id, gymId],
    );
    recordAudit(req, { action: 'update', entityType: 'nutrition_plan_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

nutritionPlanTemplatesRouter.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    const { rowCount } = await db.query(
      "UPDATE nutrition_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [actor, id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    recordAudit(req, { action: 'delete', entityType: 'nutrition_plan_template', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/duplicate', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    const { rows: srcRows } = await db.query(
      "SELECT * FROM nutrition_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const src = srcRows[0];

    let copyName = `${src.name} (Copy)`;
    const { rows: existing } = await db.query(
      'SELECT name FROM nutrition_plan_templates WHERE gym_id = ? AND name LIKE ?',
      [gymId, `${src.name} (Copy%`],
    );
    if (existing.length > 0) copyName = `${src.name} (Copy ${existing.length + 1})`;

    const newId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO nutrition_plan_templates (gym_id, name, description, member_notes, num_days, status, created_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)',
        [gymId, copyName, src.description ?? null, src.member_notes ?? null, src.num_days ?? 0, 'draft', actor, actor],
      );

      await copyTemplateContentTx(tx, id, insertId, gymId);

      return insertId;
    });

    const { rows: newRows } = await db.query(
      `SELECT npt.*,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count
       FROM nutrition_plan_templates npt
       WHERE npt.id = ?`,
      [newId],
    );
    recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: newId, next: newRows[0] });
    res.status(201).json(newRows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

/* Clone a base or gym-owned template → new gym-owned copy (with cloned_from_id tracking). */
nutritionPlanTemplatesRouter.post('/:id/clone', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { id } = req.params as { id: string };
  try {
    // Source may be a base template (gym_id IS NULL) or this gym's own template
    const { rows: srcRows } = await db.query(
      "SELECT * FROM nutrition_plan_templates WHERE id = ? AND (gym_id = ? OR gym_id IS NULL) AND status != 'deleted'",
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const src = srcRows[0];

    const baseName = req.body?.name?.trim() || `${src.name} (Copy)`;
    const { rows: conflict } = await db.query(
      "SELECT id FROM nutrition_plan_templates WHERE gym_id = ? AND name = ? AND status != 'deleted'",
      [gymId, baseName],
    );
    if (conflict.length > 0) return res.status(409).json({ error: 'A template with this name already exists in your gym' });

    const newId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO nutrition_plan_templates (gym_id, name, description, member_notes, num_days, status, created_by, modified_at, modified_by, cloned_from_id) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)',
        [gymId, baseName, src.description ?? null, src.member_notes ?? null, src.num_days ?? 0, 'draft', actor, actor, src.id],
      );

      await copyTemplateContentTx(tx, id, insertId, gymId);

      return insertId;
    });

    const { rows: newRows } = await db.query(
      `SELECT npt.*, IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type
       FROM nutrition_plan_templates npt
       WHERE npt.id = ?`,
      [newId],
    );
    recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: newId, next: newRows[0] });
    res.status(201).json(newRows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A template with this name already exists.');
  }
});

/* Assign template to a member — deep-clones into member_nutrition_plans (independent copy). */
nutritionPlanTemplatesRouter.post('/:id/assign', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { member_id, name, start_date, confirm } = req.body;
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  try {
    // Validate member belongs to this gym
    const { rows: memberRows } = await db.query(
      "SELECT id, name FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL",
      [Number(member_id), gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    // Source: base or gym-owned template
    const { rows: srcRows } = await db.query(
      "SELECT * FROM nutrition_plan_templates WHERE id = ? AND (gym_id = ? OR gym_id IS NULL) AND status != 'deleted'",
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const src = srcRows[0];

    const { planId: newPlanId } = await db.transaction((tx) => createNutritionPlanTx(tx, {
      gymId,
      memberId: Number(member_id),
      actor: resolveRequestActor(getTenantContext(req)),
      templateId: src.id,
      name: name ?? null,
      startDate: start_date ?? null,
      confirmReplace: confirm === true,
    }));

    const { rows } = await db.query(
      'SELECT * FROM member_nutrition_plans WHERE id = ?',
      [newPlanId],
    );
    recordAudit(req, { action: 'create', entityType: 'member_nutrition_plan', entityId: newPlanId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.status === 409 && err.body) return res.status(409).json(err.body);
    next(err);
  }
});

/* ---- Days ---- */

nutritionPlanTemplatesRouter.get('/:id/days', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const { rows } = await db.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
  const weekday = Number(req.body.weekday);
  if (!VALID_WEEKDAYS.includes(weekday)) {
    return res.status(400).json({ error: 'weekday must be 0–6 (Mon–Sun) or 7 (All Days)' });
  }
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ?',
      [id],
    );
    const row = await insertAndFetch(
      'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, ?, ?)',
      [gymId, id, weekday, posRows[0].next_position],
      'SELECT * FROM nutrition_plan_template_days WHERE id = ?',
      (rid) => [rid],
    );
    res.status(201).json(row);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'This weekday has already been added to the template.' });
    }
    next(err);
  }
});

nutritionPlanTemplatesRouter.put('/:id/days/reorder', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of day ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'nutrition_plan_template_days', 'nutrition_plan_template_id', id, order));
    const { rows } = await db.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  const weekday = Number(req.body.weekday);
  if (!VALID_WEEKDAYS.includes(weekday)) {
    return res.status(400).json({ error: 'weekday must be 0–6 (Mon–Sun) or 7 (All Days)' });
  }
  try {
    if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
    await db.query(
      'UPDATE nutrition_plan_template_days SET weekday = ? WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?',
      [weekday, dayId, id, gymId],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_template_days WHERE id = ?', [dayId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'This weekday has already been added to the template.' });
    }
    next(err);
  }
});

nutritionPlanTemplatesRouter.delete('/:id/days/:dayId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_days WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?',
      [dayId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Day not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ---- Meals ---- */

nutritionPlanTemplatesRouter.get('/:id/days/:dayId/meals', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  try {
    if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
    const { rows: mealRows } = await db.query(
      `${mealSelect(getRequestLocale(req))}
       WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
       ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
                i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
         WHERE i.meal_id = ?
         ORDER BY i.position ASC`,
        [meal.id],
      );
      return { ...meal, items };
    }));
    res.json(meals);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });

  const { display_name, notes } = req.body;
  // #3328 stage 2: the meal is a Base Meal (`base_meal_id`, or its slug as the legacy `meal_type`).
  const baseMeal = await resolveBaseMealInput(req.body);
  if (baseMeal.kind === 'error') return res.status(400).json({ error: baseMeal.message });
  if (baseMeal.kind === 'absent') return res.status(400).json({ error: 'base_meal_id is required' });
  const meal_type = baseMeal.slug;
  const resolvedDisplayName = display_name?.trim() || meal_type;

  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ?',
      [dayId],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, base_meal_id, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gymId, dayId, meal_type, baseMeal.id, resolvedDisplayName, notes ?? null, posRows[0].next_position],
    );
    const meal = await fetchMealWithItems(insertId, getRequestLocale(req));
    res.status(201).json(meal);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/reorder', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of meal ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'nutrition_plan_template_meals', 'nutrition_plan_template_day_id', dayId, order));
    const { rows: mealRows } = await db.query(
      `${mealSelect(getRequestLocale(req))}
       WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
       ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
                i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
         WHERE i.meal_id = ?
         ORDER BY i.position ASC`,
        [meal.id],
      );
      return { ...meal, items };
    }));
    res.json(meals);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const updates: string[] = [];
  const params: any[] = [];

  const { display_name, notes } = req.body;
  const baseMeal = await resolveBaseMealInput(req.body, db, { table: 'nutrition_plan_template_meals', mealId });
  if (baseMeal.kind === 'error') return res.status(400).json({ error: baseMeal.message });
  if (baseMeal.kind === 'ok') {
    updates.push('meal_type = ?', 'base_meal_id = ?'); params.push(baseMeal.slug, baseMeal.id);
  }
  if (display_name !== undefined) {
    if (!display_name?.trim()) return res.status(400).json({ error: 'display_name cannot be empty' });
    updates.push('display_name = ?'); params.push(display_name.trim());
  }
  if ('notes' in req.body) {
    updates.push('notes = ?'); params.push(notes ?? null);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(mealId, dayId, gymId);
  try {
    await db.query(
      `UPDATE nutrition_plan_template_meals SET ${updates.join(', ')} WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id = ?`,
      params,
    );
    const meal = await fetchMealWithItems(mealId, getRequestLocale(req));
    res.json(meal);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { dayId: string; mealId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_meals WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id = ?',
      [mealId, dayId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ---- Meal Items ---- */

nutritionPlanTemplatesRouter.get('/:id/days/:dayId/meals/:mealId/items', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { dayId: string; mealId: string };
  try {
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    const { rows } = await db.query(
      `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
              i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
       WHERE i.meal_id = ?
       ORDER BY i.position ASC`,
      [mealId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals/:mealId/items', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const { nutrition_library_item_id, component_type, quantity, unit } = req.body;
  if (!nutrition_library_item_id) return res.status(400).json({ error: 'nutrition_library_item_id is required' });
  if (!isComponentType(COMPONENT_TYPES, component_type)) {
    return res.status(400).json({ error: `component_type must be one of: ${COMPONENT_TYPES.join(', ')}` });
  }
  if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
    return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
  }

  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meal_items WHERE meal_id = ?',
      [mealId],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, base_nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?, ?, ?)',
      [gymId, mealId, Number(nutrition_library_item_id), Number(nutrition_library_item_id), component_type, quantity != null ? Number(quantity) : null, unit ?? null, posRows[0].next_position],
    );
    const { rows } = await db.query(
      `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
              i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
       WHERE i.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId/items/reorder', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { dayId: string; mealId: string };
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0 || !order.every((v: unknown) => Number.isInteger(v))) {
    return res.status(400).json({ error: 'order must be a non-empty array of item ids' });
  }
  try {
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    const { rows: current } = await db.query('SELECT id FROM nutrition_plan_template_meal_items WHERE meal_id = ? AND gym_id = ?', [mealId, gymId]);
    const currentIds = current.map((r: any) => Number(r.id)).sort((a: number, b: number) => a - b);
    const requested = [...order].sort((a: number, b: number) => a - b);
    if (currentIds.length !== requested.length || currentIds.some((v: number, i: number) => v !== requested[i])) {
      return res.status(400).json({ error: 'order must list every item of the meal exactly once' });
    }
    await db.transaction(async (tx) => reorder(tx, 'nutrition_plan_template_meal_items', 'meal_id', mealId, order));
    const { rows } = await db.query(
      `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
              i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
       WHERE i.meal_id = ?
       ORDER BY i.position ASC`,
      [mealId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId/items/:itemId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId, itemId } = req.params as { dayId: string; mealId: string; itemId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const updates: string[] = [];
  const params: any[] = [];
  const { nutrition_library_item_id, component_type, quantity, unit } = req.body;

  if (nutrition_library_item_id !== undefined) {
    if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
      return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
    }
    updates.push('nutrition_library_item_id = (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL)'); params.push(Number(nutrition_library_item_id));
    updates.push('base_nutrition_library_item_id = (SELECT id FROM base_nutrition_library_items WHERE id = ?)'); params.push(Number(nutrition_library_item_id));
  }
  if (component_type !== undefined) {
    if (!isComponentType(COMPONENT_TYPES, component_type)) {
      return res.status(400).json({ error: `component_type must be one of: ${COMPONENT_TYPES.join(', ')}` });
    }
    updates.push('component_type = ?'); params.push(component_type);
  }
  if ('quantity' in req.body) {
    updates.push('quantity = ?'); params.push(quantity != null ? Number(quantity) : null);
  }
  if ('unit' in req.body) {
    updates.push('unit = ?'); params.push(unit ?? null);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(itemId, mealId);
  try {
    const { rowCount } = await db.query(
      `UPDATE nutrition_plan_template_meal_items SET ${updates.join(', ')} WHERE id = ? AND meal_id = ?`,
      params,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal item not found' });
    const { rows } = await db.query(
      `SELECT i.id, COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))},
              i.component_type, i.quantity, i.unit, i.position, nli.image_url AS item_image_url
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(i.base_nutrition_library_item_id, i.nutrition_library_item_id)
       WHERE i.id = ?`,
      [itemId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId/items/:itemId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId, itemId } = req.params as { dayId: string; mealId: string; itemId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_meal_items WHERE id = ? AND meal_id = ?',
      [itemId, mealId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal item not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ---- Restrictions ---- */

nutritionPlanTemplatesRouter.get('/:id/restrictions', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const { rows } = await db.query(
      `SELECT r.*, COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))}, (SELECT GROUP_CONCAT(nlc.slug ORDER BY nlc.id SEPARATOR ', ') FROM nutrition_library_item_category_catalogue nlic JOIN nutrition_library_categories nlc ON nlc.id = nlic.category_id WHERE nlic.item_id = nli.id) AS item_category, nli.image_url AS item_image_url
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id)
       WHERE r.nutrition_plan_template_id = ? AND r.gym_id = ?
       ORDER BY r.position ASC`,
      [id, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/restrictions', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
  const { nutrition_library_item_id, applies_all_days } = req.body;
  if (!nutrition_library_item_id) return res.status(400).json({ error: 'nutrition_library_item_id is required' });
  if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
    return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
  }
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, base_nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?)',
      [gymId, id, Number(nutrition_library_item_id), Number(nutrition_library_item_id), applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
    );
    const { rows } = await db.query(
      `SELECT r.*, COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))}, (SELECT GROUP_CONCAT(nlc.slug ORDER BY nlc.id SEPARATOR ', ') FROM nutrition_library_item_category_catalogue nlic JOIN nutrition_library_categories nlc ON nlc.id = nlic.category_id WHERE nlic.item_id = nli.id) AS item_category, nli.image_url AS item_image_url
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id)
       WHERE r.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/restrictions/:rid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, rid } = req.params as { id: string; rid: string };
  const updates: string[] = [];
  const params: any[] = [];
  const { nutrition_library_item_id, applies_all_days } = req.body;
  if (nutrition_library_item_id !== undefined) {
    if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
      return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
    }
    updates.push('nutrition_library_item_id = (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL)'); params.push(Number(nutrition_library_item_id));
    updates.push('base_nutrition_library_item_id = (SELECT id FROM base_nutrition_library_items WHERE id = ?)'); params.push(Number(nutrition_library_item_id));
  }
  if (applies_all_days !== undefined) { updates.push('applies_all_days = ?'); params.push(Number(applies_all_days)); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(rid, id, gymId);
  try {
    const { rowCount } = await db.query(
      `UPDATE nutrition_plan_template_restrictions SET ${updates.join(', ')} WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?`,
      params,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Restriction not found' });
    const { rows } = await db.query(
      `SELECT r.*, COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id) AS nutrition_library_item_id, ${localizedNameExpr('nli', getRequestLocale(req))}, (SELECT GROUP_CONCAT(nlc.slug ORDER BY nlc.id SEPARATOR ', ') FROM nutrition_library_item_category_catalogue nlic JOIN nutrition_library_categories nlc ON nlc.id = nlic.category_id WHERE nlic.item_id = nli.id) AS item_category, nli.image_url AS item_image_url
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_item_catalogue nli ON nli.id = COALESCE(r.base_nutrition_library_item_id, r.nutrition_library_item_id)
       WHERE r.id = ?`,
      [rid],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/restrictions/:rid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, rid } = req.params as { id: string; rid: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_restrictions WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?',
      [rid, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Restriction not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ---- Goals ---- */

nutritionPlanTemplatesRouter.get('/:id/goals', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const { rows } = await db.query(
      goalRowsSql('nutrition_plan_template_goals', 'g.nutrition_plan_template_id = ? AND g.gym_id = ?', getRequestLocale(req)),
      [id, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/goals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
  const { item_name, quantity, unit, frequency, applies_all_days, nutrition_library_item_id } = req.body;
  if (!item_name || !(NUTRITION_GOALS as readonly string[]).includes(item_name)) {
    return res.status(400).json({ error: `item_name must be one of: ${NUTRITION_GOALS.join(', ')}` });
  }
  if (quantity == null || isNaN(Number(quantity))) return res.status(400).json({ error: 'quantity is required and must be a number' });
  if (!unit?.trim()) return res.status(400).json({ error: 'unit is required' });
  // #932: the food that illustrates the goal, optional.
  const illustration = parseGoalIllustrationInput(nutrition_library_item_id);
  if ('error' in illustration) return res.status(400).json({ error: illustration.error });
  try {
    const illustrationErr = await validateGoalIllustration(gymId, illustration.id);
    if (illustrationErr) return res.status(400).json({ error: illustrationErr });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position, nutrition_library_item_id, base_nutrition_library_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?))',
      [gymId, id, item_name, Number(quantity), unit.trim(), frequency?.trim() ?? 'daily', applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position, illustration.id, illustration.id],
    );
    const { rows } = await db.query(goalRowsSql('nutrition_plan_template_goals', 'g.id = ?', getRequestLocale(req)), [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/goals/:gid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, gid } = req.params as { id: string; gid: string };
  const updates: string[] = [];
  const params: any[] = [];
  const { item_name, quantity, unit, frequency, applies_all_days, nutrition_library_item_id } = req.body;
  if (nutrition_library_item_id !== undefined) {
    // #932: absent keeps, null clears, an id must be a food the gym may use.
    const illustration = parseGoalIllustrationInput(nutrition_library_item_id);
    if ('error' in illustration) return res.status(400).json({ error: illustration.error });
    const illustrationErr = await validateGoalIllustration(gymId, illustration.id);
    if (illustrationErr) return res.status(400).json({ error: illustrationErr });
    updates.push('nutrition_library_item_id = (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL)'); params.push(illustration.id);
    updates.push('base_nutrition_library_item_id = (SELECT id FROM base_nutrition_library_items WHERE id = ?)'); params.push(illustration.id);
  }
  if (item_name !== undefined) {
    if (!(NUTRITION_GOALS as readonly string[]).includes(item_name)) {
      return res.status(400).json({ error: `item_name must be one of: ${NUTRITION_GOALS.join(', ')}` });
    }
    updates.push('item_name = ?'); params.push(item_name);
  }
  if (quantity !== undefined) {
    if (isNaN(Number(quantity))) return res.status(400).json({ error: 'quantity must be a number' });
    updates.push('quantity = ?'); params.push(Number(quantity));
  }
  if (unit !== undefined) {
    if (!unit?.trim()) return res.status(400).json({ error: 'unit cannot be empty' });
    updates.push('unit = ?'); params.push(unit.trim());
  }
  if (frequency !== undefined) { updates.push('frequency = ?'); params.push(frequency?.trim() ?? 'daily'); }
  if (applies_all_days !== undefined) { updates.push('applies_all_days = ?'); params.push(Number(applies_all_days)); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(gid, id, gymId);
  try {
    const { rowCount } = await db.query(
      `UPDATE nutrition_plan_template_goals SET ${updates.join(', ')} WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?`,
      params,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Goal not found' });
    const { rows } = await db.query(goalRowsSql('nutrition_plan_template_goals', 'g.id = ?', getRequestLocale(req)), [gid]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/goals/:gid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, gid } = req.params as { id: string; gid: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_goals WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id = ?',
      [gid, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Goal not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

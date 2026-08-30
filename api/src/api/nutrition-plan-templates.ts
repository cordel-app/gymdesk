import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';

export const nutritionPlanTemplatesRouter = Router();

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

const MEAL_TYPES = [
  'recien_levantado', 'breakfast', 'media_manana',
  'lunch', 'snack', 'dinner', 'antes_de_dormir',
] as const;

const COMPONENT_TYPES = ['main_dish', 'side', 'sauce', 'additional'] as const;

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
  const { rows } = await db.query('SELECT 1 FROM nutrition_library_items WHERE id = ?', [id]);
  return rows.length > 0;
}

const MEAL_SELECT = `
  SELECT m.id, m.gym_id, m.nutrition_plan_template_day_id,
         m.meal_type, m.display_name, m.notes, m.position
  FROM nutrition_plan_template_meals m
`;

async function fetchMealWithItems(mealId: string | number) {
  const { rows: mealRows } = await db.query(
    `${MEAL_SELECT} WHERE m.id = ?`,
    [mealId],
  );
  if (mealRows.length === 0) return null;
  const meal = mealRows[0];
  const { rows: items } = await db.query(
    `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
            i.component_type, i.quantity, i.unit, i.position
     FROM nutrition_plan_template_meal_items i
     JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
     WHERE i.meal_id = ?
     ORDER BY i.position ASC`,
    [mealId],
  );
  return { ...meal, items };
}

/* ---- Templates ---- */

nutritionPlanTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  // ?type=base|gym filters by owner; default returns both
  const type = req.query.type as 'base' | 'gym' | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const createdBy = req.query.created_by == null || req.query.created_by === ''
    ? null : Number(req.query.created_by);
  if (createdBy !== null && !Number.isInteger(createdBy)) {
    return res.status(400).json({ error: 'created_by must be a membership id' });
  }
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS ? req.query.sort : 'name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    // Scope: gym-owned rows always included; base (gym_id IS NULL) included unless type=gym
    const scopeClause = type === 'base'
      ? 'npt.gym_id IS NULL'
      : type === 'gym'
        ? 'npt.gym_id = ?'
        : '(npt.gym_id = ? OR npt.gym_id IS NULL)';
    const scopeParams: any[] = type === 'base' ? [] : [gymId];

    const where: string[] = [scopeClause, "npt.status != 'deleted'"];
    const params: any[] = [...scopeParams];
    if (status) { where.push('npt.status = ?'); params.push(status); }
    if (name) { where.push('npt.name LIKE ?'); params.push(`%${name}%`); }
    if (createdBy !== null) { where.push('npt.created_by_membership_id = ?'); params.push(createdBy); }
    const whereSql = where.join(' AND ');

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM nutrition_plan_templates npt WHERE ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT npt.*,
              IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type,
              gm_c.name AS created_by_name,
              gm_m.name AS modified_by_name,
              gm_d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count
       FROM nutrition_plan_templates npt
       LEFT JOIN gym_memberships gm_c ON gm_c.id = npt.created_by_membership_id
       LEFT JOIN gym_memberships gm_m ON gm_m.id = npt.modified_by_membership_id
       LEFT JOIN gym_memberships gm_d ON gm_d.id = npt.deleted_by_membership_id
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
      `SELECT DISTINCT gm.id AS membership_id, gm.name
       FROM nutrition_plan_templates npt
       JOIN gym_memberships gm ON gm.id = npt.created_by_membership_id
       WHERE npt.gym_id = ? AND npt.status != 'deleted' AND gm.name IS NOT NULL
       ORDER BY gm.name ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT npt.*, IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type, gm.name AS created_by_name
       FROM nutrition_plan_templates npt
       LEFT JOIN gym_memberships gm ON gm.id = npt.created_by_membership_id
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
          ? `${MEAL_SELECT} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ? ORDER BY m.position ASC`
          : `${MEAL_SELECT} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id IS NULL ORDER BY m.position ASC`,
        gymIdFilter ? [day.id, gymIdFilter] : [day.id],
      );
      const meals = await Promise.all(mealRows.map(async (meal: any) => {
        const { rows: items } = await db.query(
          `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                  i.component_type, i.quantity, i.unit, i.position
           FROM nutrition_plan_template_meal_items i
           JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
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
        ? `SELECT r.*, nli.name AS item_name, nli.category AS item_category
           FROM nutrition_plan_template_restrictions r
           JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
           WHERE r.nutrition_plan_template_id = ? AND r.gym_id = ?
           ORDER BY r.position ASC`
        : `SELECT r.*, nli.name AS item_name, nli.category AS item_category
           FROM nutrition_plan_template_restrictions r
           JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
           WHERE r.nutrition_plan_template_id = ? AND r.gym_id IS NULL
           ORDER BY r.position ASC`,
      gymIdFilter ? [id, gymIdFilter] : [id],
    );

    const { rows: goalRows } = await db.query(
      gymIdFilter
        ? 'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC'
        : 'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      gymIdFilter ? [id, gymIdFilter] : [id],
    );

    res.json({ ...tplRows[0], days, restrictions: restrictionRows, goals: goalRows });
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const row = await insertAndFetch(
      'INSERT INTO nutrition_plan_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
      [gymId, name.trim(), description ?? null, status ?? 'active', gymMembershipId],
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
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE nutrition_plan_templates SET
        name = COALESCE(?, name), description = IF(?, ?, description), status = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, status ?? null, gymMembershipId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    const { rows } = await db.query(
      `SELECT npt.*, gm_c.name AS created_by_name, gm_m.name AS modified_by_name
       FROM nutrition_plan_templates npt
       LEFT JOIN gym_memberships gm_c ON gm_c.id = npt.created_by_membership_id
       LEFT JOIN gym_memberships gm_m ON gm_m.id = npt.modified_by_membership_id
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
  const { gymId, gymMembershipId, actorName } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rowCount } = await db.query(
      "UPDATE nutrition_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?, deleted_by_name = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [gymMembershipId, actorName, id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    recordAudit(req, { action: 'delete', entityType: 'nutrition_plan_template', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/duplicate', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
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
        'INSERT INTO nutrition_plan_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
        [gymId, copyName, src.description ?? null, 'draft', gymMembershipId],
      );

      // Clone days → meals → meal_items
      const { rows: days } = await tx.query(
        'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const day of days) {
        const { insertId: newDayId } = await tx.query(
          'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, ?, ?)',
          [gymId, insertId, day.weekday, day.position],
        );
        const { rows: meals } = await tx.query(
          'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC',
          [day.id],
        );
        for (const meal of meals) {
          const { insertId: newMealId } = await tx.query(
            'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, newDayId, meal.meal_type ?? null, meal.display_name, meal.notes ?? null, meal.position],
          );
          const { rows: items } = await tx.query(
            'SELECT * FROM nutrition_plan_template_meal_items WHERE meal_id = ? ORDER BY position ASC',
            [meal.id],
          );
          for (const item of items) {
            await tx.query(
              'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [gymId, newMealId, item.nutrition_library_item_id, item.component_type, item.quantity ?? null, item.unit ?? null, item.position],
            );
          }
        }
      }

      // Clone restrictions
      const { rows: restrictions } = await tx.query(
        'SELECT * FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const r of restrictions) {
        await tx.query(
          'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, r.nutrition_library_item_id, r.applies_all_days, r.position],
        );
      }

      // Clone goals
      const { rows: goals } = await tx.query(
        'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const g of goals) {
        await tx.query(
          'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [gymId, insertId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position],
        );
      }

      return insertId;
    });

    const { rows: newRows } = await db.query(
      `SELECT npt.*,
              gm_c.name AS created_by_name,
              gm_m.name AS modified_by_name,
              gm_d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count
       FROM nutrition_plan_templates npt
       LEFT JOIN gym_memberships gm_c ON gm_c.id = npt.created_by_membership_id
       LEFT JOIN gym_memberships gm_m ON gm_m.id = npt.modified_by_membership_id
       LEFT JOIN gym_memberships gm_d ON gm_d.id = npt.deleted_by_membership_id
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
  const { gymId, gymMembershipId } = getTenantContext(req);
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
        'INSERT INTO nutrition_plan_templates (gym_id, name, description, status, created_by_membership_id, cloned_from_id) VALUES (?, ?, ?, ?, ?, ?)',
        [gymId, baseName, src.description ?? null, 'draft', gymMembershipId, src.id],
      );

      const { rows: days } = await tx.query(
        'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const day of days) {
        const { insertId: newDayId } = await tx.query(
          'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, ?, ?)',
          [gymId, insertId, day.weekday, day.position],
        );
        const { rows: meals } = await tx.query(
          'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC',
          [day.id],
        );
        for (const meal of meals) {
          const { insertId: newMealId } = await tx.query(
            'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, newDayId, meal.meal_type ?? null, meal.display_name, meal.notes ?? null, meal.position],
          );
          const { rows: items } = await tx.query(
            'SELECT * FROM nutrition_plan_template_meal_items WHERE meal_id = ? ORDER BY position ASC',
            [meal.id],
          );
          for (const item of items) {
            await tx.query(
              'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [gymId, newMealId, item.nutrition_library_item_id, item.component_type, item.quantity ?? null, item.unit ?? null, item.position],
            );
          }
        }
      }

      const { rows: restrictions } = await tx.query(
        'SELECT * FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const r of restrictions) {
        await tx.query(
          'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, r.nutrition_library_item_id, r.applies_all_days, r.position],
        );
      }

      const { rows: goals } = await tx.query(
        'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const g of goals) {
        await tx.query(
          'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [gymId, insertId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position],
        );
      }

      return insertId;
    });

    const { rows: newRows } = await db.query(
      `SELECT npt.*, IF(npt.gym_id IS NULL, 'base', 'gym') AS owner_type,
              gm_c.name AS created_by_name
       FROM nutrition_plan_templates npt
       LEFT JOIN gym_memberships gm_c ON gm_c.id = npt.created_by_membership_id
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
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { member_id, start_date } = req.body;
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

    const newPlanId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO member_nutrition_plans (gym_id, member_id, template_id, name, description, start_date, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [gymId, Number(member_id), src.id, src.name, src.description ?? null, start_date ?? null, 'active', gymMembershipId],
      );

      const { rows: days } = await tx.query(
        'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const day of days) {
        const { insertId: newDayId } = await tx.query(
          'INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position) VALUES (?, ?, ?, ?)',
          [gymId, insertId, day.weekday, day.position],
        );
        const { rows: meals } = await tx.query(
          'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC',
          [day.id],
        );
        for (const meal of meals) {
          const { insertId: newMealId } = await tx.query(
            'INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, newDayId, meal.meal_type ?? null, meal.display_name, meal.notes ?? null, meal.position],
          );
          const { rows: items } = await tx.query(
            'SELECT * FROM nutrition_plan_template_meal_items WHERE meal_id = ? ORDER BY position ASC',
            [meal.id],
          );
          for (const item of items) {
            await tx.query(
              'INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [gymId, newMealId, item.nutrition_library_item_id, item.component_type, item.quantity ?? null, item.unit ?? null, item.position],
            );
          }
        }
      }

      const { rows: restrictions } = await tx.query(
        'SELECT * FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const r of restrictions) {
        await tx.query(
          'INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, r.nutrition_library_item_id, r.applies_all_days, r.position],
        );
      }

      const { rows: goals } = await tx.query(
        'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const g of goals) {
        await tx.query(
          'INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [gymId, insertId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position],
        );
      }

      return insertId;
    });

    const { rows } = await db.query(
      'SELECT * FROM member_nutrition_plans WHERE id = ?',
      [newPlanId],
    );
    recordAudit(req, { action: 'create', entityType: 'member_nutrition_plan', entityId: newPlanId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
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
      `${MEAL_SELECT}
       WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
       ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                i.component_type, i.quantity, i.unit, i.position
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
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

  const { meal_type, display_name, notes } = req.body;
  if (!meal_type || !(MEAL_TYPES as readonly string[]).includes(meal_type)) {
    return res.status(400).json({ error: `meal_type must be one of: ${MEAL_TYPES.join(', ')}` });
  }
  const resolvedDisplayName = display_name?.trim() || meal_type;

  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ?',
      [dayId],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
      [gymId, dayId, meal_type, resolvedDisplayName, notes ?? null, posRows[0].next_position],
    );
    const meal = await fetchMealWithItems(insertId);
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
      `${MEAL_SELECT}
       WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
       ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                i.component_type, i.quantity, i.unit, i.position
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
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
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const updates: string[] = [];
  const params: any[] = [];

  const { meal_type, display_name, notes } = req.body;
  if (meal_type !== undefined) {
    if (!(MEAL_TYPES as readonly string[]).includes(meal_type)) {
      return res.status(400).json({ error: `meal_type must be one of: ${MEAL_TYPES.join(', ')}` });
    }
    updates.push('meal_type = ?'); params.push(meal_type);
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
    const meal = await fetchMealWithItems(mealId);
    res.json(meal);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
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
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  try {
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    const { rows } = await db.query(
      `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
              i.component_type, i.quantity, i.unit, i.position
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
       WHERE i.meal_id = ?
       ORDER BY i.position ASC`,
      [mealId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals/:mealId/items', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const { nutrition_library_item_id, component_type, quantity, unit } = req.body;
  if (!nutrition_library_item_id) return res.status(400).json({ error: 'nutrition_library_item_id is required' });
  if (!component_type || !(COMPONENT_TYPES as readonly string[]).includes(component_type)) {
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
      'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gymId, mealId, Number(nutrition_library_item_id), component_type, quantity != null ? Number(quantity) : null, unit ?? null, posRows[0].next_position],
    );
    const { rows } = await db.query(
      `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
              i.component_type, i.quantity, i.unit, i.position
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
       WHERE i.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId/items/:itemId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId, itemId } = req.params as { id: string; dayId: string; mealId: string; itemId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const updates: string[] = [];
  const params: any[] = [];
  const { nutrition_library_item_id, component_type, quantity, unit } = req.body;

  if (nutrition_library_item_id !== undefined) {
    if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
      return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
    }
    updates.push('nutrition_library_item_id = ?'); params.push(Number(nutrition_library_item_id));
  }
  if (component_type !== undefined) {
    if (!(COMPONENT_TYPES as readonly string[]).includes(component_type)) {
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
      `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
              i.component_type, i.quantity, i.unit, i.position
       FROM nutrition_plan_template_meal_items i
       JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
       WHERE i.id = ?`,
      [itemId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId/items/:itemId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId, itemId } = req.params as { id: string; dayId: string; mealId: string; itemId: string };
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
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
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
      'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
      [gymId, id, Number(nutrition_library_item_id), applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
    );
    const { rows } = await db.query(
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
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
    updates.push('nutrition_library_item_id = ?'); params.push(Number(nutrition_library_item_id));
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
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
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
      'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/goals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  if (!(await templateExists(id, gymId))) return res.status(404).json({ error: 'Nutrition plan template not found' });
  const { item_name, quantity, unit, frequency, applies_all_days } = req.body;
  if (!item_name || !(NUTRITION_GOALS as readonly string[]).includes(item_name)) {
    return res.status(400).json({ error: `item_name must be one of: ${NUTRITION_GOALS.join(', ')}` });
  }
  if (quantity == null || isNaN(Number(quantity))) return res.status(400).json({ error: 'quantity is required and must be a number' });
  if (!unit?.trim()) return res.status(400).json({ error: 'unit is required' });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [gymId, id, item_name, Number(quantity), unit.trim(), frequency?.trim() ?? 'daily', applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_template_goals WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/goals/:gid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, gid } = req.params as { id: string; gid: string };
  const updates: string[] = [];
  const params: any[] = [];
  const { item_name, quantity, unit, frequency, applies_all_days } = req.body;
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
    const { rows } = await db.query('SELECT * FROM nutrition_plan_template_goals WHERE id = ?', [gid]);
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

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

/* ---- Templates ---- */

nutritionPlanTemplatesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
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
    const where: string[] = ['npt.gym_id = ?', "npt.status != 'deleted'"];
    const params: any[] = [gymId];
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
      `SELECT npt.*, gm.name AS created_by_name
       FROM nutrition_plan_templates npt
       LEFT JOIN gym_memberships gm ON gm.id = npt.created_by_membership_id
       WHERE npt.id = ? AND npt.gym_id = ? AND npt.status != 'deleted'`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Full hierarchy: template → days → meals (with library items) + restrictions + goals
nutritionPlanTemplatesRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows: tplRows } = await db.query(
      "SELECT id, name, status FROM nutrition_plan_templates WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (tplRows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });

    // Days → meals with library item names
    const { rows: dayRows } = await db.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    const days = await Promise.all(dayRows.map(async (day: any) => {
      const { rows: mealRows } = await db.query(
        `SELECT m.*,
                md.name AS main_dish_name,
                si.name AS side_name,
                sa.name AS sauce_name,
                dr.name AS drink_name
         FROM nutrition_plan_template_meals m
         LEFT JOIN nutrition_library_items md ON md.id = m.main_dish_id
         LEFT JOIN nutrition_library_items si ON si.id = m.side_id
         LEFT JOIN nutrition_library_items sa ON sa.id = m.sauce_id
         LEFT JOIN nutrition_library_items dr ON dr.id = m.drink_id
         WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
         ORDER BY m.position ASC`,
        [day.id, gymId],
      );
      return { ...day, meals: mealRows };
    }));

    // Restrictions (template-level)
    const { rows: restrictionRows } = await db.query(
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
       WHERE r.nutrition_plan_template_id = ? AND r.gym_id = ?
       ORDER BY r.position ASC`,
      [id, gymId],
    );

    // Goals (template-level)
    const { rows: goalRows } = await db.query(
      'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
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
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rowCount } = await db.query(
      "UPDATE nutrition_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [gymMembershipId, id, gymId],
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

      // Clone days → meals
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
          await tx.query(
            'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, name, position, main_dish_id, side_id, sauce_id, drink_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [gymId, newDayId, meal.name, meal.position, meal.main_dish_id ?? null, meal.side_id ?? null, meal.sauce_id ?? null, meal.drink_id ?? null],
          );
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
    const { rows } = await db.query(
      `SELECT m.*,
              md.name AS main_dish_name,
              si.name AS side_name,
              sa.name AS sauce_name,
              dr.name AS drink_name
       FROM nutrition_plan_template_meals m
       LEFT JOIN nutrition_library_items md ON md.id = m.main_dish_id
       LEFT JOIN nutrition_library_items si ON si.id = m.side_id
       LEFT JOIN nutrition_library_items sa ON sa.id = m.sauce_id
       LEFT JOIN nutrition_library_items dr ON dr.id = m.drink_id
       WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
       ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
  const { name, main_dish_id, side_id, sauce_id, drink_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (main_dish_id != null && !(await libraryItemExists(Number(main_dish_id)))) {
    return res.status(400).json({ error: 'main_dish_id is not a valid nutrition library item' });
  }
  if (side_id != null && !(await libraryItemExists(Number(side_id)))) {
    return res.status(400).json({ error: 'side_id is not a valid nutrition library item' });
  }
  if (sauce_id != null && !(await libraryItemExists(Number(sauce_id)))) {
    return res.status(400).json({ error: 'sauce_id is not a valid nutrition library item' });
  }
  if (drink_id != null && !(await libraryItemExists(Number(drink_id)))) {
    return res.status(400).json({ error: 'drink_id is not a valid nutrition library item' });
  }
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ?',
      [dayId],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, name, position, main_dish_id, side_id, sauce_id, drink_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [gymId, dayId, name.trim(), posRows[0].next_position, main_dish_id ?? null, side_id ?? null, sauce_id ?? null, drink_id ?? null],
    );
    const { rows } = await db.query(
      `SELECT m.*, md.name AS main_dish_name, si.name AS side_name, sa.name AS sauce_name, dr.name AS drink_name
       FROM nutrition_plan_template_meals m
       LEFT JOIN nutrition_library_items md ON md.id = m.main_dish_id
       LEFT JOIN nutrition_library_items si ON si.id = m.side_id
       LEFT JOIN nutrition_library_items sa ON sa.id = m.sauce_id
       LEFT JOIN nutrition_library_items dr ON dr.id = m.drink_id
       WHERE m.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
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
    const { rows } = await db.query(
      `SELECT m.*, md.name AS main_dish_name, si.name AS side_name, sa.name AS sauce_name, dr.name AS drink_name
       FROM nutrition_plan_template_meals m
       LEFT JOIN nutrition_library_items md ON md.id = m.main_dish_id
       LEFT JOIN nutrition_library_items si ON si.id = m.side_id
       LEFT JOIN nutrition_library_items sa ON sa.id = m.sauce_id
       LEFT JOIN nutrition_library_items dr ON dr.id = m.drink_id
       WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id = ?
       ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });

  const updates: string[] = [];
  const params: any[] = [];

  const { name, main_dish_id, side_id, sauce_id, drink_id } = req.body;
  if (name !== undefined) {
    if (!name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    updates.push('name = ?'); params.push(name.trim());
  }
  if ('main_dish_id' in req.body) {
    if (main_dish_id != null && !(await libraryItemExists(Number(main_dish_id)))) {
      return res.status(400).json({ error: 'main_dish_id is not a valid nutrition library item' });
    }
    updates.push('main_dish_id = ?'); params.push(main_dish_id ?? null);
  }
  if ('side_id' in req.body) {
    if (side_id != null && !(await libraryItemExists(Number(side_id)))) {
      return res.status(400).json({ error: 'side_id is not a valid nutrition library item' });
    }
    updates.push('side_id = ?'); params.push(side_id ?? null);
  }
  if ('sauce_id' in req.body) {
    if (sauce_id != null && !(await libraryItemExists(Number(sauce_id)))) {
      return res.status(400).json({ error: 'sauce_id is not a valid nutrition library item' });
    }
    updates.push('sauce_id = ?'); params.push(sauce_id ?? null);
  }
  if ('drink_id' in req.body) {
    if (drink_id != null && !(await libraryItemExists(Number(drink_id)))) {
      return res.status(400).json({ error: 'drink_id is not a valid nutrition library item' });
    }
    updates.push('drink_id = ?'); params.push(drink_id ?? null);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(mealId, dayId, gymId);
  try {
    await db.query(
      `UPDATE nutrition_plan_template_meals SET ${updates.join(', ')} WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id = ?`,
      params,
    );
    const { rows } = await db.query(
      `SELECT m.*, md.name AS main_dish_name, si.name AS side_name, sa.name AS sauce_name, dr.name AS drink_name
       FROM nutrition_plan_template_meals m
       LEFT JOIN nutrition_library_items md ON md.id = m.main_dish_id
       LEFT JOIN nutrition_library_items si ON si.id = m.side_id
       LEFT JOIN nutrition_library_items sa ON sa.id = m.sauce_id
       LEFT JOIN nutrition_library_items dr ON dr.id = m.drink_id
       WHERE m.id = ?`,
      [mealId],
    );
    res.json(rows[0]);
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
  if (!item_name?.trim()) return res.status(400).json({ error: 'item_name is required' });
  if (quantity == null || isNaN(Number(quantity))) return res.status(400).json({ error: 'quantity is required and must be a number' });
  if (!unit?.trim()) return res.status(400).json({ error: 'unit is required' });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [gymId, id, item_name.trim(), Number(quantity), unit.trim(), frequency?.trim() ?? 'daily', applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
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
    if (!item_name?.trim()) return res.status(400).json({ error: 'item_name cannot be empty' });
    updates.push('item_name = ?'); params.push(item_name.trim());
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

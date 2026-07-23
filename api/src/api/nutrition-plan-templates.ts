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

// Full hierarchy: template → days → meals → meal_dishes (with dish/side/sauce detail)
nutritionPlanTemplatesRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      `SELECT npt.id, npt.name, npt.status,
        (SELECT JSON_ARRAYAGG(day_item) FROM (
          SELECT JSON_OBJECT(
            'id', d.id, 'weekday', d.weekday, 'position', d.position,
            'meals', (SELECT JSON_ARRAYAGG(meal_item) FROM (
              SELECT JSON_OBJECT(
                'id', m.id, 'name', m.name, 'position', m.position,
                'dishes', (SELECT JSON_ARRAYAGG(dish_item) FROM (
                  SELECT JSON_OBJECT(
                    'id', md.id, 'position', md.position,
                    'dish_id', md.dish_id, 'dish_name', di.name,
                    'dish_description', di.description,
                    'dish_calories', di.calories, 'dish_protein', di.protein,
                    'dish_carbohydrates', di.carbohydrates, 'dish_fat', di.fat,
                    'side_id', md.side_id, 'side_name', si.name,
                    'sauce_id', md.sauce_id, 'sauce_name', sa.name
                  ) AS dish_item
                  FROM nutrition_plan_template_meal_dishes md
                  JOIN dishes di ON di.id = md.dish_id
                  LEFT JOIN sides si ON si.id = md.side_id
                  LEFT JOIN sauces sa ON sa.id = md.sauce_id
                  WHERE md.nutrition_plan_template_meal_id = m.id
                  ORDER BY md.position
                ) t3)
              ) AS meal_item
              FROM nutrition_plan_template_meals m
              WHERE m.nutrition_plan_template_day_id = d.id
              ORDER BY m.position
            ) t2)
          ) AS day_item
          FROM nutrition_plan_template_days d
          WHERE d.nutrition_plan_template_id = npt.id
          ORDER BY d.position
        ) t1) AS days
       FROM nutrition_plan_templates npt
       WHERE npt.id = ? AND npt.gym_id = ? AND npt.status != 'deleted'`,
      [id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
    res.json(rows[0]);
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

nutritionPlanTemplatesRouter.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { rowCount } = await db.query(
    "UPDATE nutrition_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [gymMembershipId, id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Nutrition plan template not found' });
  recordAudit(req, { action: 'delete', entityType: 'nutrition_plan_template', entityId: id });
  res.status(204).send();
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

    const newTemplate = await db.transaction(async (tx) => {
      const { insertId: newId } = await tx.query(
        'INSERT INTO nutrition_plan_templates (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
        [gymId, copyName, src.description ?? null, 'draft', gymMembershipId],
      );

      const { rows: days } = await tx.query(
        'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
        [id],
      );
      for (const day of days) {
        const { insertId: newDayId } = await tx.query(
          'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, ?, ?)',
          [gymId, newId, day.weekday, day.position],
        );
        const { rows: meals } = await tx.query(
          'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC',
          [day.id],
        );
        for (const meal of meals) {
          const { insertId: newMealId } = await tx.query(
            'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, name, position) VALUES (?, ?, ?, ?)',
            [gymId, newDayId, meal.name, meal.position],
          );
          const { rows: mealDishes } = await tx.query(
            'SELECT * FROM nutrition_plan_template_meal_dishes WHERE nutrition_plan_template_meal_id = ? ORDER BY position ASC',
            [meal.id],
          );
          for (const md of mealDishes) {
            await tx.query(
              'INSERT INTO nutrition_plan_template_meal_dishes (gym_id, nutrition_plan_template_meal_id, dish_id, side_id, sauce_id, position) VALUES (?, ?, ?, ?, ?, ?)',
              [gymId, newMealId, md.dish_id, md.side_id ?? null, md.sauce_id ?? null, md.position],
            );
          }
        }
      }
      return newId;
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
      [newTemplate],
    );
    recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: newTemplate, next: newRows[0] });
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
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return res.status(400).json({ error: 'weekday must be an integer between 0 (Monday) and 6 (Sunday)' });
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
      'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? AND gym_id = ? ORDER BY position ASC',
      [dayId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ?',
      [dayId],
    );
    const row = await insertAndFetch(
      'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, name, position) VALUES (?, ?, ?, ?)',
      [gymId, dayId, name.trim(), posRows[0].next_position],
      'SELECT * FROM nutrition_plan_template_meals WHERE id = ?',
      (rid) => [rid],
    );
    res.status(201).json(row);
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
      'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? AND gym_id = ? ORDER BY position ASC',
      [dayId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    await db.query(
      'UPDATE nutrition_plan_template_meals SET name = ? WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id = ?',
      [name.trim(), mealId, dayId, gymId],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_template_meals WHERE id = ?', [mealId]);
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

/* ---- Meal Dishes ---- */

nutritionPlanTemplatesRouter.get('/:id/days/:dayId/meals/:mealId/dishes', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  try {
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    const { rows } = await db.query(
      `SELECT md.*, di.name AS dish_name, di.description AS dish_description,
              di.calories AS dish_calories, di.protein AS dish_protein,
              di.carbohydrates AS dish_carbohydrates, di.fat AS dish_fat,
              si.name AS side_name, sa.name AS sauce_name
       FROM nutrition_plan_template_meal_dishes md
       JOIN dishes di ON di.id = md.dish_id
       LEFT JOIN sides si ON si.id = md.side_id
       LEFT JOIN sauces sa ON sa.id = md.sauce_id
       WHERE md.nutrition_plan_template_meal_id = ? AND md.gym_id = ?
       ORDER BY md.position ASC`,
      [mealId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals/:mealId/dishes', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
  const dishId = Number(req.body.dish_id);
  if (!Number.isInteger(dishId) || dishId <= 0) return res.status(400).json({ error: 'dish_id is required' });
  const sideId = req.body.side_id ? Number(req.body.side_id) : null;
  const sauceId = req.body.sauce_id ? Number(req.body.sauce_id) : null;
  try {
    const { rows: dishRows } = await db.query('SELECT 1 FROM dishes WHERE id = ? AND gym_id = ?', [dishId, gymId]);
    if (dishRows.length === 0) return res.status(400).json({ error: 'dish_id does not belong to this gym' });
    if (sideId) {
      const { rows: sideRows } = await db.query('SELECT 1 FROM sides WHERE id = ? AND gym_id = ?', [sideId, gymId]);
      if (sideRows.length === 0) return res.status(400).json({ error: 'side_id does not belong to this gym' });
    }
    if (sauceId) {
      const { rows: sauceRows } = await db.query('SELECT 1 FROM sauces WHERE id = ? AND gym_id = ?', [sauceId, gymId]);
      if (sauceRows.length === 0) return res.status(400).json({ error: 'sauce_id does not belong to this gym' });
    }

    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meal_dishes WHERE nutrition_plan_template_meal_id = ?',
      [mealId],
    );
    const row = await insertAndFetch(
      'INSERT INTO nutrition_plan_template_meal_dishes (gym_id, nutrition_plan_template_meal_id, dish_id, side_id, sauce_id, position) VALUES (?, ?, ?, ?, ?, ?)',
      [gymId, mealId, dishId, sideId, sauceId, posRows[0].next_position],
      `SELECT md.*, di.name AS dish_name, di.description AS dish_description,
              di.calories AS dish_calories, di.protein AS dish_protein,
              di.carbohydrates AS dish_carbohydrates, di.fat AS dish_fat,
              si.name AS side_name, sa.name AS sauce_name
       FROM nutrition_plan_template_meal_dishes md
       JOIN dishes di ON di.id = md.dish_id
       LEFT JOIN sides si ON si.id = md.side_id
       LEFT JOIN sauces sa ON sa.id = md.sauce_id
       WHERE md.id = ?`,
      (rid) => [rid],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId/dishes/reorder', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of meal dish ids' });
  try {
    await db.transaction(async (tx) => reorder(tx, 'nutrition_plan_template_meal_dishes', 'nutrition_plan_template_meal_id', mealId, order));
    const { rows } = await db.query(
      `SELECT md.*, di.name AS dish_name, si.name AS side_name, sa.name AS sauce_name
       FROM nutrition_plan_template_meal_dishes md
       JOIN dishes di ON di.id = md.dish_id
       LEFT JOIN sides si ON si.id = md.side_id
       LEFT JOIN sauces sa ON sa.id = md.sauce_id
       WHERE md.nutrition_plan_template_meal_id = ? AND md.gym_id = ?
       ORDER BY md.position ASC`,
      [mealId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId/dishes/:mealDishId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { dayId, mealId, mealDishId } = req.params as { id: string; dayId: string; mealId: string; mealDishId: string };
  if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
  const updates: string[] = [];
  const params: any[] = [];
  if ('side_id' in req.body) {
    const sideId = req.body.side_id ? Number(req.body.side_id) : null;
    if (sideId) {
      const { rows } = await db.query('SELECT 1 FROM sides WHERE id = ? AND gym_id = ?', [sideId, gymId]);
      if (rows.length === 0) return res.status(400).json({ error: 'side_id does not belong to this gym' });
    }
    updates.push('side_id = ?'); params.push(sideId);
  }
  if ('sauce_id' in req.body) {
    const sauceId = req.body.sauce_id ? Number(req.body.sauce_id) : null;
    if (sauceId) {
      const { rows } = await db.query('SELECT 1 FROM sauces WHERE id = ? AND gym_id = ?', [sauceId, gymId]);
      if (rows.length === 0) return res.status(400).json({ error: 'sauce_id does not belong to this gym' });
    }
    updates.push('sauce_id = ?'); params.push(sauceId);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(mealDishId, mealId, gymId);
  try {
    const { rowCount } = await db.query(
      `UPDATE nutrition_plan_template_meal_dishes SET ${updates.join(', ')} WHERE id = ? AND nutrition_plan_template_meal_id = ? AND gym_id = ?`,
      params,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal dish not found' });
    const { rows } = await db.query(
      `SELECT md.*, di.name AS dish_name, si.name AS side_name, sa.name AS sauce_name
       FROM nutrition_plan_template_meal_dishes md
       JOIN dishes di ON di.id = md.dish_id
       LEFT JOIN sides si ON si.id = md.side_id
       LEFT JOIN sauces sa ON sa.id = md.sauce_id
       WHERE md.id = ?`,
      [mealDishId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

nutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId/dishes/:mealDishId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { mealId, mealDishId } = req.params as { id: string; dayId: string; mealId: string; mealDishId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_meal_dishes WHERE id = ? AND nutrition_plan_template_meal_id = ? AND gym_id = ?',
      [mealDishId, mealId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal dish not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

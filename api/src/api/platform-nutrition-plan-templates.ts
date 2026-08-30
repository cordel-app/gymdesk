import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';

export const platformNutritionPlanTemplatesRouter = Router();

const STATUSES = ['active', 'inactive', 'draft', 'deleted'];
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

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function baseTemplateExists(id: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM nutrition_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
    [id],
  );
  return rows.length > 0;
}

async function baseDayExists(templateId: string, dayId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM nutrition_plan_template_days WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id IS NULL',
    [dayId, templateId],
  );
  return rows.length > 0;
}

async function baseMealExists(dayId: string, mealId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM nutrition_plan_template_meals WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id IS NULL',
    [mealId, dayId],
  );
  return rows.length > 0;
}

async function libraryItemExists(id: number): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM nutrition_library_items WHERE id = ? AND status != 'deleted'",
    [id],
  );
  return rows.length > 0;
}

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string | number, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

const MEAL_SELECT = `
  SELECT m.id, m.gym_id, m.nutrition_plan_template_day_id,
         m.meal_type, m.display_name, m.notes, m.position
  FROM nutrition_plan_template_meals m
`;

async function fetchMealWithItems(mealId: string | number) {
  const { rows: mealRows } = await db.query(`${MEAL_SELECT} WHERE m.id = ?`, [mealId]);
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

/* ── Templates ───────────────────────────────────────────────────────────── */

platformNutritionPlanTemplatesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const where: string[] = ['npt.gym_id IS NULL'];
    const params: any[] = [];
    if (status) { where.push('npt.status = ?'); params.push(status); }
    else        { where.push("npt.status != 'deleted'"); }

    const { rows } = await db.query(
      `SELECT npt.id, npt.name, npt.description, npt.status, npt.created_at, npt.modified_at,
              (SELECT COUNT(*) FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = npt.id) AS day_count
       FROM nutrition_plan_templates npt
       WHERE ${where.join(' AND ')}
       ORDER BY npt.name ASC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    const { rows } = await db.query(
      "SELECT * FROM nutrition_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.get('/:id/hierarchy', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    const { rows: tplRows } = await db.query(
      "SELECT id, name, status FROM nutrition_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if (tplRows.length === 0) return res.status(404).json({ error: 'Template not found' });

    const { rows: dayRows } = await db.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      [id],
    );
    const days = await Promise.all(dayRows.map(async (day: any) => {
      const { rows: mealRows } = await db.query(
        `${MEAL_SELECT} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id IS NULL ORDER BY m.position ASC`,
        [day.id],
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
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
       WHERE r.nutrition_plan_template_id = ? AND r.gym_id IS NULL
       ORDER BY r.position ASC`,
      [id],
    );
    const { rows: goalRows } = await db.query(
      'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      [id],
    );

    res.json({ ...tplRows[0], days, restrictions: restrictionRows, goals: goalRows });
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM nutrition_plan_templates WHERE gym_id IS NULL AND name = ? AND status != 'deleted'",
      [name.trim()],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'A base template with this name already exists' });

    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_templates (gym_id, name, description, status) VALUES (NULL, ?, ?, ?)',
      [name.trim(), description ?? null, status ?? 'draft'],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_templates WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'nutrition_plan_template', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id, name FROM nutrition_plan_templates WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Template not found' });

    if (name?.trim() && name.trim() !== existing[0].name) {
      const { rows: conflict } = await db.query(
        "SELECT id FROM nutrition_plan_templates WHERE gym_id IS NULL AND name = ? AND id != ? AND status != 'deleted'",
        [name.trim(), id],
      );
      if (conflict.length > 0) return res.status(409).json({ error: 'A base template with this name already exists' });
    }

    await db.query(
      `UPDATE nutrition_plan_templates SET
         name = COALESCE(?, name),
         description = IF(? IS NOT NULL, ?, description),
         status = COALESCE(?, status),
         modified_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [name?.trim() ?? null, description !== undefined ? description : null, description ?? null, status ?? null, id],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_templates WHERE id = ?', [id]);
    recordAudit(req, { action: 'update', entityType: 'nutrition_plan_template', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    const { rowCount } = await db.query(
      "UPDATE nutrition_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id IS NULL AND status != 'deleted'",
      [id],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Template not found' });
    recordAudit(req, { action: 'delete', entityType: 'nutrition_plan_template', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Days ────────────────────────────────────────────────────────────────── */

platformNutritionPlanTemplatesRouter.get('/:id/days', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await db.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.post('/:id/days', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
  const weekday = Number(req.body.weekday);
  if (!VALID_WEEKDAYS.includes(weekday)) {
    return res.status(400).json({ error: 'weekday must be 0–6 (Mon–Sun) or 7 (All Days)' });
  }
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (NULL, ?, ?, ?)',
      [id, weekday, posRows[0].next_position],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_template_days WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'This weekday has already been added to the template.' });
    }
    next(err);
  }
});

platformNutritionPlanTemplatesRouter.put('/:id/days/reorder', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'order must be a non-empty array of day ids' });
  }
  try {
    await db.transaction(async (tx) => reorder(tx, 'nutrition_plan_template_days', 'nutrition_plan_template_id', id, order));
    const { rows } = await db.query(
      'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.delete('/:id/days/:dayId', requireSuperadmin, async (req, res, next) => {
  const { id, dayId } = req.params as { id: string; dayId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_days WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id IS NULL',
      [dayId, id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Day not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Meals ───────────────────────────────────────────────────────────────── */

platformNutritionPlanTemplatesRouter.get('/:id/days/:dayId/meals', requireSuperadmin, async (req, res, next) => {
  const { id, dayId } = req.params as { id: string; dayId: string };
  try {
    if (!(await baseDayExists(id, dayId))) return res.status(404).json({ error: 'Day not found' });
    const { rows: mealRows } = await db.query(
      `${MEAL_SELECT} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id IS NULL ORDER BY m.position ASC`,
      [dayId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                i.component_type, i.quantity, i.unit, i.position
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
         WHERE i.meal_id = ? ORDER BY i.position ASC`,
        [meal.id],
      );
      return { ...meal, items };
    }));
    res.json(meals);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals', requireSuperadmin, async (req, res, next) => {
  const { id, dayId } = req.params as { id: string; dayId: string };
  if (!(await baseDayExists(id, dayId))) return res.status(404).json({ error: 'Day not found' });
  const { meal_type, display_name, notes } = req.body;
  if (!meal_type || !(MEAL_TYPES as readonly string[]).includes(meal_type)) {
    return res.status(400).json({ error: `meal_type must be one of: ${MEAL_TYPES.join(', ')}` });
  }
  try {
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ?',
      [dayId],
    );
    const { insertId } = await db.query(
      'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, display_name, notes, position) VALUES (NULL, ?, ?, ?, ?, ?)',
      [dayId, meal_type, display_name?.trim() || meal_type, notes ?? null, posRows[0].next_position],
    );
    const meal = await fetchMealWithItems(insertId);
    res.status(201).json(meal);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/reorder', requireSuperadmin, async (req, res, next) => {
  const { id, dayId } = req.params as { id: string; dayId: string };
  if (!(await baseDayExists(id, dayId))) return res.status(404).json({ error: 'Day not found' });
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'order must be a non-empty array of meal ids' });
  }
  try {
    await db.transaction(async (tx) => reorder(tx, 'nutrition_plan_template_meals', 'nutrition_plan_template_day_id', dayId, order));
    const { rows: mealRows } = await db.query(
      `${MEAL_SELECT} WHERE m.nutrition_plan_template_day_id = ? AND m.gym_id IS NULL ORDER BY m.position ASC`,
      [dayId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                i.component_type, i.quantity, i.unit, i.position
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
         WHERE i.meal_id = ? ORDER BY i.position ASC`,
        [meal.id],
      );
      return { ...meal, items };
    }));
    res.json(meals);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.put('/:id/days/:dayId/meals/:mealId', requireSuperadmin, async (req, res, next) => {
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await baseMealExists(dayId, mealId))) return res.status(404).json({ error: 'Meal not found' });
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
  if ('notes' in req.body) { updates.push('notes = ?'); params.push(notes ?? null); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(mealId, dayId);
  try {
    await db.query(
      `UPDATE nutrition_plan_template_meals SET ${updates.join(', ')} WHERE id = ? AND nutrition_plan_template_day_id = ?`,
      params,
    );
    res.json(await fetchMealWithItems(mealId));
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId', requireSuperadmin, async (req, res, next) => {
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_meals WHERE id = ? AND nutrition_plan_template_day_id = ? AND gym_id IS NULL',
      [mealId, dayId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Meal Items ──────────────────────────────────────────────────────────── */

platformNutritionPlanTemplatesRouter.post('/:id/days/:dayId/meals/:mealId/items', requireSuperadmin, async (req, res, next) => {
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  if (!(await baseMealExists(dayId, mealId))) return res.status(404).json({ error: 'Meal not found' });
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
      'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (NULL, ?, ?, ?, ?, ?, ?)',
      [mealId, Number(nutrition_library_item_id), component_type, quantity != null ? Number(quantity) : null, unit ?? null, posRows[0].next_position],
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

platformNutritionPlanTemplatesRouter.delete('/:id/days/:dayId/meals/:mealId/items/:itemId', requireSuperadmin, async (req, res, next) => {
  const { mealId, itemId } = req.params as { mealId: string; itemId: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_meal_items WHERE id = ? AND meal_id = ?',
      [itemId, mealId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Restrictions ────────────────────────────────────────────────────────── */

platformNutritionPlanTemplatesRouter.get('/:id/restrictions', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await db.query(
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM nutrition_plan_template_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
       WHERE r.nutrition_plan_template_id = ? AND r.gym_id IS NULL
       ORDER BY r.position ASC`,
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.post('/:id/restrictions', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
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
      'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, applies_all_days, position) VALUES (NULL, ?, ?, ?, ?)',
      [id, Number(nutrition_library_item_id), applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
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

platformNutritionPlanTemplatesRouter.delete('/:id/restrictions/:rid', requireSuperadmin, async (req, res, next) => {
  const { id, rid } = req.params as { id: string; rid: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_restrictions WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id IS NULL',
      [rid, id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Restriction not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Goals ───────────────────────────────────────────────────────────────── */

platformNutritionPlanTemplatesRouter.get('/:id/goals', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  try {
    if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await db.query(
      'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? AND gym_id IS NULL ORDER BY position ASC',
      [id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.post('/:id/goals', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params as { id: string };
  if (!(await baseTemplateExists(id))) return res.status(404).json({ error: 'Template not found' });
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
      'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)',
      [id, item_name, Number(quantity), unit.trim(), frequency?.trim() ?? 'daily', applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
    );
    const { rows } = await db.query('SELECT * FROM nutrition_plan_template_goals WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

platformNutritionPlanTemplatesRouter.delete('/:id/goals/:gid', requireSuperadmin, async (req, res, next) => {
  const { id, gid } = req.params as { id: string; gid: string };
  try {
    const { rowCount } = await db.query(
      'DELETE FROM nutrition_plan_template_goals WHERE id = ? AND nutrition_plan_template_id = ? AND gym_id IS NULL',
      [gid, id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Goal not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

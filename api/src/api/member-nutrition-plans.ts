import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';

export const memberNutritionPlansRouter = Router();

// member_nutrition_plan_meal_items.component_type has a narrower CHECK than the
// template equivalent (chk_mnpmi_comp, migration 105) — no drink/dessert/other.
const COMPONENT_TYPES = ['main_dish', 'side', 'sauce', 'additional'] as const;
const MEAL_TYPES = [
  'recien_levantado', 'breakfast', 'media_manana',
  'lunch', 'snack', 'dinner', 'antes_de_dormir',
] as const;
const NUTRITION_GOALS = [
  'protein', 'water', 'calories', 'carbohydrates', 'fats', 'fiber',
  'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
  'performance', 'recovery', 'energy',
] as const;
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6, 7];

const PLAN_SELECT = `
  SELECT mnp.*, m.name AS member_name,
         gm_c.name AS created_by_name,
         gm_m.name AS modified_by_name,
         (SELECT COUNT(*) FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = mnp.id) AS day_count
  FROM member_nutrition_plans mnp
  JOIN members m ON m.id = mnp.member_id
  LEFT JOIN gym_memberships gm_c ON gm_c.id = mnp.created_by_membership_id
  LEFT JOIN gym_memberships gm_m ON gm_m.id = mnp.modified_by_membership_id
`;

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Loads the plan and writes a 404/403 response itself when it can't be mutated; returns null in that case. */
async function loadActivePlan(res: any, id: string, gymId: string) {
  const { rows } = await db.query(
    "SELECT * FROM member_nutrition_plans WHERE id = ? AND gym_id = ? AND status != 'deleted'",
    [id, gymId],
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Member nutrition plan not found' }); return null; }
  if (rows[0].status !== 'active') {
    res.status(403).json({ error: 'This nutrition plan is read-only and cannot be modified.' });
    return null;
  }
  return rows[0];
}

async function dayExists(planId: string, dayId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM member_nutrition_plan_days WHERE id = ? AND member_nutrition_plan_id = ? AND gym_id = ?',
    [dayId, planId, gymId],
  );
  return rows.length > 0;
}

async function mealExists(dayId: string, mealId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM member_nutrition_plan_meals WHERE id = ? AND member_nutrition_plan_day_id = ? AND gym_id = ?',
    [mealId, dayId, gymId],
  );
  return rows.length > 0;
}

async function libraryItemExists(id: number): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM nutrition_library_items WHERE id = ?', [id]);
  return rows.length > 0;
}

async function reorder(tx: Tx, table: string, parentColumn: string, parentId: string | number, orderedIds: number[]) {
  await tx.query(`UPDATE ${table} SET position = position + 1000000 WHERE ${parentColumn} = ?`, [parentId]);
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.query(`UPDATE ${table} SET position = ? WHERE id = ? AND ${parentColumn} = ?`, [i + 1, orderedIds[i], parentId]);
  }
}

const MEAL_SELECT = `
  SELECT m.id, m.gym_id, m.member_nutrition_plan_day_id,
         m.meal_type, m.display_name, m.notes, m.position
  FROM member_nutrition_plan_meals m
`;

async function fetchMealWithItems(mealId: string | number) {
  const { rows: mealRows } = await db.query(`${MEAL_SELECT} WHERE m.id = ?`, [mealId]);
  if (mealRows.length === 0) return null;
  const meal = mealRows[0];
  const { rows: items } = await db.query(
    `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
            i.component_type, i.quantity, i.unit, i.position
     FROM member_nutrition_plan_meal_items i
     JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
     WHERE i.meal_id = ?
     ORDER BY i.position ASC`,
    [mealId],
  );
  return { ...meal, items };
}

/* ── List ─────────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  if (memberId !== null && !Number.isInteger(memberId)) {
    return res.status(400).json({ error: 'member_id must be an integer' });
  }
  try {
    const where: string[] = ["mnp.gym_id = ?", "mnp.status != 'deleted'"];
    const params: any[] = [gymId];
    if (memberId !== null) { where.push('mnp.member_id = ?'); params.push(memberId); }

    const { rows } = await db.query(
      `${PLAN_SELECT} WHERE ${where.join(' AND ')} ORDER BY mnp.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Get single ───────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${PLAN_SELECT} WHERE mnp.id = ? AND mnp.gym_id = ? AND mnp.status != 'deleted'`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Edit ─────────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { name, description, start_date } = req.body;
  if ('name' in req.body && !name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    await db.query(
      `UPDATE member_nutrition_plans SET
        name = COALESCE(?, name), description = IF(?, ?, description), start_date = IF(?, ?, start_date),
        modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        'start_date' in req.body ? 1 : 0, start_date ?? null,
        gymMembershipId, id, gymId,
      ],
    );
    const { rows } = await db.query(`${PLAN_SELECT} WHERE mnp.id = ? AND mnp.gym_id = ?`, [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'member_nutrition_plan', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Complete ─────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/complete', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    await db.query(
      "UPDATE member_nutrition_plans SET status = 'completed', modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ? WHERE id = ? AND gym_id = ?",
      [gymMembershipId, id, gymId],
    );
    const { rows } = await db.query(`${PLAN_SELECT} WHERE mnp.id = ? AND mnp.gym_id = ?`, [id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'member_nutrition_plan', entityId: id, next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Duplicate ────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/duplicate', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows: srcRows } = await db.query(
      "SELECT * FROM member_nutrition_plans WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (srcRows.length === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });
    const src = srcRows[0];

    let copyName = `${src.name} (Copy)`;
    const { rows: existing } = await db.query(
      'SELECT name FROM member_nutrition_plans WHERE gym_id = ? AND member_id = ? AND name LIKE ? AND status != \'deleted\'',
      [gymId, src.member_id, `${src.name} (Copy%`],
    );
    if (existing.length > 0) copyName = `${src.name} (Copy ${existing.length + 1})`;

    const newId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO member_nutrition_plans (gym_id, member_id, template_id, name, description, start_date, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?, CURRENT_DATE(), ?, ?)',
        [gymId, src.member_id, src.template_id, copyName, src.description ?? null, 'active', gymMembershipId],
      );

      const { rows: days } = await tx.query(
        'SELECT * FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ? ORDER BY position ASC',
        [id],
      );
      for (const day of days) {
        const { insertId: newDayId } = await tx.query(
          'INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position) VALUES (?, ?, ?, ?)',
          [gymId, insertId, day.weekday, day.position],
        );
        const { rows: meals } = await tx.query(
          'SELECT * FROM member_nutrition_plan_meals WHERE member_nutrition_plan_day_id = ? ORDER BY position ASC',
          [day.id],
        );
        for (const meal of meals) {
          const { insertId: newMealId } = await tx.query(
            'INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, newDayId, meal.meal_type ?? null, meal.display_name, meal.notes ?? null, meal.position],
          );
          const { rows: items } = await tx.query(
            'SELECT * FROM member_nutrition_plan_meal_items WHERE meal_id = ? ORDER BY position ASC',
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
        'SELECT * FROM member_nutrition_plan_restrictions WHERE member_nutrition_plan_id = ? ORDER BY position ASC',
        [id],
      );
      for (const r of restrictions) {
        await tx.query(
          'INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
          [gymId, insertId, r.nutrition_library_item_id, r.applies_all_days, r.position],
        );
      }

      const { rows: goals } = await tx.query(
        'SELECT * FROM member_nutrition_plan_goals WHERE member_nutrition_plan_id = ? ORDER BY position ASC',
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

    const { rows: newRows } = await db.query(`${PLAN_SELECT} WHERE mnp.id = ?`, [newId]);
    recordAudit(req, { action: 'create', entityType: 'member_nutrition_plan', entityId: newId, next: newRows[0] });
    res.status(201).json(newRows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A plan with this name already exists for this member.');
  }
});

/* ── Full hierarchy ───────────────────────────────────────────────────────── */

memberNutritionPlansRouter.get('/:id/hierarchy', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  try {
    const { rows: planRows } = await db.query(
      "SELECT id, name, status FROM member_nutrition_plans WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [id, gymId],
    );
    if (planRows.length === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });

    const { rows: dayRows } = await db.query(
      'SELECT * FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    const days = await Promise.all(dayRows.map(async (day: any) => {
      const { rows: mealRows } = await db.query(
        `${MEAL_SELECT} WHERE m.member_nutrition_plan_day_id = ? AND m.gym_id = ? ORDER BY m.position ASC`,
        [day.id, gymId],
      );
      const meals = await Promise.all(mealRows.map(async (meal: any) => {
        const { rows: items } = await db.query(
          `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                  i.component_type, i.quantity, i.unit, i.position
           FROM member_nutrition_plan_meal_items i
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
       FROM member_nutrition_plan_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
       WHERE r.member_nutrition_plan_id = ? AND r.gym_id = ?
       ORDER BY r.position ASC`,
      [id, gymId],
    );
    const { rows: goalRows } = await db.query(
      'SELECT * FROM member_nutrition_plan_goals WHERE member_nutrition_plan_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );

    res.json({ ...planRows[0], days, restrictions: restrictionRows, goals: goalRows });
  } catch (err) { next(err); }
});

/* ── Soft delete ──────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      "UPDATE member_nutrition_plans SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ? AND status != 'deleted'",
      [gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Member nutrition plan not found' });
    recordAudit(req, { action: 'delete', entityType: 'member_nutrition_plan', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Days ─────────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/days', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const weekday = Number(req.body.weekday);
  if (!VALID_WEEKDAYS.includes(weekday)) {
    return res.status(400).json({ error: 'weekday must be 0–6 (Mon–Sun) or 7 (All Days)' });
  }
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position) VALUES (?, ?, ?, ?)',
      [gymId, id, weekday, posRows[0].next_position],
    );
    const { rows } = await db.query('SELECT * FROM member_nutrition_plan_days WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'This weekday has already been added to the plan.' });
    }
    next(err);
  }
});

memberNutritionPlansRouter.put('/:id/days/reorder', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of day ids' });
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    await db.transaction(async (tx) => reorder(tx, 'member_nutrition_plan_days', 'member_nutrition_plan_id', id, order));
    const { rows } = await db.query(
      'SELECT * FROM member_nutrition_plan_days WHERE member_nutrition_plan_id = ? AND gym_id = ? ORDER BY position ASC',
      [id, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.delete('/:id/days/:dayId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    const { rowCount } = await db.query(
      'DELETE FROM member_nutrition_plan_days WHERE id = ? AND member_nutrition_plan_id = ? AND gym_id = ?',
      [dayId, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Day not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Meals ────────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/days/:dayId/meals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  const { meal_type, display_name, notes } = req.body;
  if (!meal_type || !(MEAL_TYPES as readonly string[]).includes(meal_type)) {
    return res.status(400).json({ error: `meal_type must be one of: ${MEAL_TYPES.join(', ')}` });
  }
  const resolvedDisplayName = display_name?.trim() || meal_type;
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM member_nutrition_plan_meals WHERE member_nutrition_plan_day_id = ?',
      [dayId],
    );
    const { insertId } = await db.query(
      'INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?)',
      [gymId, dayId, meal_type, resolvedDisplayName, notes ?? null, posRows[0].next_position],
    );
    const meal = await fetchMealWithItems(insertId);
    res.status(201).json(meal);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.put('/:id/days/:dayId/meals/reorder', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId } = req.params as { id: string; dayId: string };
  const order = req.body.order;
  if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of meal ids' });
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await dayExists(id, dayId, gymId))) return res.status(404).json({ error: 'Day not found' });
    await db.transaction(async (tx) => reorder(tx, 'member_nutrition_plan_meals', 'member_nutrition_plan_day_id', dayId, order));
    const { rows: mealRows } = await db.query(
      `${MEAL_SELECT} WHERE m.member_nutrition_plan_day_id = ? AND m.gym_id = ? ORDER BY m.position ASC`,
      [dayId, gymId],
    );
    const meals = await Promise.all(mealRows.map(async (meal: any) => {
      const { rows: items } = await db.query(
        `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
                i.component_type, i.quantity, i.unit, i.position
         FROM member_nutrition_plan_meal_items i
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

memberNutritionPlansRouter.put('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
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

  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    params.push(mealId, dayId, gymId);
    await db.query(
      `UPDATE member_nutrition_plan_meals SET ${updates.join(', ')} WHERE id = ? AND member_nutrition_plan_day_id = ? AND gym_id = ?`,
      params,
    );
    const meal = await fetchMealWithItems(mealId);
    res.json(meal);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.delete('/:id/days/:dayId/meals/:mealId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    const { rowCount } = await db.query(
      'DELETE FROM member_nutrition_plan_meals WHERE id = ? AND member_nutrition_plan_day_id = ? AND gym_id = ?',
      [mealId, dayId, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Meal Items ───────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/days/:dayId/meals/:mealId/items', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId } = req.params as { id: string; dayId: string; mealId: string };
  const { nutrition_library_item_id, component_type, quantity, unit } = req.body;
  if (!nutrition_library_item_id) return res.status(400).json({ error: 'nutrition_library_item_id is required' });
  if (!component_type || !(COMPONENT_TYPES as readonly string[]).includes(component_type)) {
    return res.status(400).json({ error: `component_type must be one of: ${COMPONENT_TYPES.join(', ')}` });
  }
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
      return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
    }
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM member_nutrition_plan_meal_items WHERE meal_id = ?',
      [mealId],
    );
    const { insertId } = await db.query(
      'INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gymId, mealId, Number(nutrition_library_item_id), component_type, quantity != null ? Number(quantity) : null, unit ?? null, posRows[0].next_position],
    );
    const { rows } = await db.query(
      `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
              i.component_type, i.quantity, i.unit, i.position
       FROM member_nutrition_plan_meal_items i
       JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
       WHERE i.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.put('/:id/days/:dayId/meals/:mealId/items/:itemId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId, itemId } = req.params as { id: string; dayId: string; mealId: string; itemId: string };
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

  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    params.push(itemId, mealId);
    const { rowCount } = await db.query(
      `UPDATE member_nutrition_plan_meal_items SET ${updates.join(', ')} WHERE id = ? AND meal_id = ?`,
      params,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal item not found' });
    const { rows } = await db.query(
      `SELECT i.id, i.nutrition_library_item_id, nli.name AS item_name,
              i.component_type, i.quantity, i.unit, i.position
       FROM member_nutrition_plan_meal_items i
       JOIN nutrition_library_items nli ON nli.id = i.nutrition_library_item_id
       WHERE i.id = ?`,
      [itemId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.delete('/:id/days/:dayId/meals/:mealId/items/:itemId', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, dayId, mealId, itemId } = req.params as { id: string; dayId: string; mealId: string; itemId: string };
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await mealExists(dayId, mealId, gymId))) return res.status(404).json({ error: 'Meal not found' });
    const { rowCount } = await db.query(
      'DELETE FROM member_nutrition_plan_meal_items WHERE id = ? AND meal_id = ?',
      [itemId, mealId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Meal item not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Restrictions ─────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/restrictions', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { nutrition_library_item_id, applies_all_days } = req.body;
  if (!nutrition_library_item_id) return res.status(400).json({ error: 'nutrition_library_item_id is required' });
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    if (!(await libraryItemExists(Number(nutrition_library_item_id)))) {
      return res.status(400).json({ error: 'nutrition_library_item_id is not a valid nutrition library item' });
    }
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM member_nutrition_plan_restrictions WHERE member_nutrition_plan_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, ?, ?, ?)',
      [gymId, id, Number(nutrition_library_item_id), applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
    );
    const { rows } = await db.query(
      `SELECT r.*, nli.name AS item_name, nli.category AS item_category
       FROM member_nutrition_plan_restrictions r
       JOIN nutrition_library_items nli ON nli.id = r.nutrition_library_item_id
       WHERE r.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.delete('/:id/restrictions/:rid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, rid } = req.params as { id: string; rid: string };
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    const { rowCount } = await db.query(
      'DELETE FROM member_nutrition_plan_restrictions WHERE id = ? AND member_nutrition_plan_id = ? AND gym_id = ?',
      [rid, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Restriction not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Goals ────────────────────────────────────────────────────────────────── */

memberNutritionPlansRouter.post('/:id/goals', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params as { id: string };
  const { item_name, quantity, unit, frequency, applies_all_days } = req.body;
  if (!item_name || !(NUTRITION_GOALS as readonly string[]).includes(item_name)) {
    return res.status(400).json({ error: `item_name must be one of: ${NUTRITION_GOALS.join(', ')}` });
  }
  if (quantity == null || isNaN(Number(quantity))) return res.status(400).json({ error: 'quantity is required and must be a number' });
  if (!unit?.trim()) return res.status(400).json({ error: 'unit is required' });
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    const { rows: posRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM member_nutrition_plan_goals WHERE member_nutrition_plan_id = ?',
      [id],
    );
    const { insertId } = await db.query(
      'INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency, applies_all_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [gymId, id, item_name, Number(quantity), unit.trim(), frequency?.trim() ?? 'daily', applies_all_days != null ? Number(applies_all_days) : 1, posRows[0].next_position],
    );
    const { rows } = await db.query('SELECT * FROM member_nutrition_plan_goals WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

memberNutritionPlansRouter.delete('/:id/goals/:gid', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id, gid } = req.params as { id: string; gid: string };
  try {
    const plan = await loadActivePlan(res, id, gymId);
    if (!plan) return;
    const { rowCount } = await db.query(
      'DELETE FROM member_nutrition_plan_goals WHERE id = ? AND member_nutrition_plan_id = ? AND gym_id = ?',
      [gid, id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Goal not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const platformNutritionLibraryRouter = Router();

const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;
type Category = typeof CATEGORIES[number];

/* ── List ─────────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const category = req.query.category as string | undefined;
  const status   = req.query.status   as string | undefined;
  if (category && !CATEGORIES.includes(category as Category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }
  try {
    const where: string[] = ['gym_id IS NULL'];
    const params: any[] = [];
    if (category) { where.push('category = ?'); params.push(category); }
    if (status)   { where.push('status = ?');   params.push(status); }
    else          { where.push("status != 'deleted'"); }

    const { rows } = await db.query(
      `SELECT id, name, category, status, created_at, modified_at
       FROM nutrition_library_items
       WHERE ${where.join(' AND ')}
       ORDER BY category ASC, name ASC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Create ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, category } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!category || !CATEGORIES.includes(category as Category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM nutrition_library_items WHERE gym_id IS NULL AND name = ? AND category = ? AND status != 'deleted'",
      [name.trim(), category],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name and category already exists' });

    const { insertId } = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, category, status) VALUES (NULL, ?, ?, 'active')",
      [name.trim(), category],
    );
    const { rows } = await db.query(
      'SELECT id, name, category, status, created_at, modified_at FROM nutrition_library_items WHERE id = ?',
      [insertId],
    );
    recordAudit(req, { action: 'create', entityType: 'nutrition_library_item', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { name, category } = req.body;

  if (category !== undefined && !CATEGORIES.includes(category as Category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id, name, category, status FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    if (name?.trim()) {
      const resolvedCategory = category ?? existing[0].category;
      const { rows: conflict } = await db.query(
        "SELECT id FROM nutrition_library_items WHERE gym_id IS NULL AND name = ? AND category = ? AND id != ? AND status != 'deleted'",
        [name.trim(), resolvedCategory, id],
      );
      if (conflict.length > 0) return res.status(409).json({ error: 'An item with this name and category already exists' });
    }

    const updates: string[] = ['modified_at = UTC_TIMESTAMP()'];
    const params: any[] = [];
    if (name?.trim())  { updates.push('name = ?');     params.push(name.trim()); }
    if (category)      { updates.push('category = ?'); params.push(category); }

    params.push(id);
    await db.query(`UPDATE nutrition_library_items SET ${updates.join(', ')} WHERE id = ?`, params);

    const { rows } = await db.query(
      'SELECT id, name, category, status, created_at, modified_at FROM nutrition_library_items WHERE id = ?',
      [id],
    );
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, previous: existing[0], next: rows[0] });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── Soft delete ──────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  try {
    const { rows: existing } = await db.query(
      "SELECT id, status FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is already deleted' });

    await db.query(
      "UPDATE nutrition_library_items SET status = 'deleted', modified_at = UTC_TIMESTAMP() WHERE id = ?",
      [id],
    );
    recordAudit(req, { action: 'delete', entityType: 'nutrition_library_item', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

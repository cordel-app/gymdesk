import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const platformNutritionLibraryRouter = Router();

const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;
type Category = typeof CATEGORIES[number];

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Return qualities assigned to a set of item IDs as a map: item_id → [{id, slug}] */
async function loadQualitiesMap(itemIds: number[]): Promise<Record<number, { id: number; slug: string }[]>> {
  if (itemIds.length === 0) return {};
  const marks = itemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ item_id: number; quality_id: number; slug: string }>(
    `SELECT nliq.item_id, nq.id AS quality_id, nq.slug
     FROM nutrition_library_item_qualities nliq
     JOIN nutritional_qualities nq ON nq.id = nliq.quality_id
     WHERE nliq.item_id IN (${marks})
     ORDER BY nq.id`,
    itemIds,
  );
  const map: Record<number, { id: number; slug: string }[]> = {};
  for (const row of rows) {
    if (!map[row.item_id]) map[row.item_id] = [];
    map[row.item_id].push({ id: row.quality_id, slug: row.slug });
  }
  return map;
}

/** Replace all quality assignments for an item inside a transaction. */
async function replaceQualities(itemId: number, qualityIds: number[]): Promise<void> {
  await db.transaction(async (conn) => {
    await conn.query('DELETE FROM nutrition_library_item_qualities WHERE item_id = ?', [itemId]);
    for (const qid of qualityIds) {
      await conn.query(
        'INSERT INTO nutrition_library_item_qualities (item_id, quality_id) VALUES (?, ?)',
        [itemId, qid],
      );
    }
  });
}

/** Validate that all given quality IDs exist. Returns 400 error message or null. */
async function validateQualityIds(ids: unknown): Promise<{ error: string } | null> {
  if (!Array.isArray(ids)) return { error: 'quality_ids must be an array' };
  if (ids.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return { error: 'quality_ids must be positive integers' };
  }
  if (ids.length === 0) return null;
  const marks = ids.map(() => '?').join(',');
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM nutritional_qualities WHERE id IN (${marks})`,
    ids,
  );
  if (rows.length !== ids.length) return { error: 'One or more quality_ids are invalid' };
  return null;
}

/* ── Nutritional Qualities catalogue (read-only for now) ─────────────────── */

platformNutritionLibraryRouter.get('/nutritional-qualities', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, slug FROM nutritional_qualities ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

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

    const { rows } = await db.query<{ id: number; name: string; category: string; status: string; created_at: string; modified_at: string | null }>(
      `SELECT id, name, category, status, created_at, modified_at
       FROM nutrition_library_items
       WHERE ${where.join(' AND ')}
       ORDER BY category ASC, name ASC`,
      params,
    );

    const qualitiesMap = await loadQualitiesMap(rows.map((r) => r.id));
    res.json(rows.map((r) => ({ ...r, qualities: qualitiesMap[r.id] ?? [] })));
  } catch (err) { next(err); }
});

/* ── Create ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, category, quality_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!category || !CATEGORIES.includes(category as Category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
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

    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids);
    }

    const { rows } = await db.query(
      'SELECT id, name, category, status, created_at, modified_at FROM nutrition_library_items WHERE id = ?',
      [insertId],
    );
    const qualitiesMap = await loadQualitiesMap([insertId]);
    const item = { ...rows[0], qualities: qualitiesMap[insertId] ?? [] };
    recordAudit(req, { action: 'create', entityType: 'nutrition_library_item', entityId: insertId, next: item });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { name, category, quality_ids } = req.body;

  if (category !== undefined && !CATEGORIES.includes(category as Category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
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

    if (Array.isArray(quality_ids)) {
      await replaceQualities(Number(id), quality_ids);
    }

    const { rows } = await db.query(
      'SELECT id, name, category, status, created_at, modified_at FROM nutrition_library_items WHERE id = ?',
      [id],
    );
    const qualitiesMap = await loadQualitiesMap([Number(id)]);
    const item = { ...rows[0], qualities: qualitiesMap[Number(id)] ?? [] };
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, previous: existing[0], next: item });
    res.json(item);
  } catch (err) { next(err); }
});

/* ── Qualities sub-resource ───────────────────────────────────────────────── */

platformNutritionLibraryRouter.put('/:id/qualities', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { quality_ids } = req.body;

  const err = await validateQualityIds(quality_ids);
  if (err) return res.status(400).json(err);

  try {
    const { rows: existing } = await db.query(
      "SELECT id, status FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    await replaceQualities(Number(id), quality_ids);

    const qualitiesMap = await loadQualitiesMap([Number(id)]);
    res.json({ item_id: Number(id), qualities: qualitiesMap[Number(id)] ?? [] });
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

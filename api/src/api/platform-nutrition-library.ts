import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  CATEGORIES, Category,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  buildListWhere, clampLimit, clampOffset,
} from '../domain/nutritionLibrary';

export const platformNutritionLibraryRouter = Router();

/* ── Nutritional Qualities catalogue (read-only for now) ─────────────────── */

platformNutritionLibraryRouter.get('/nutritional-qualities', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, slug FROM nutritional_qualities ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── List ─────────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  const base = ['gym_id IS NULL', status ? 'status = ?' : "status != 'deleted'"];
  const baseParams = status ? [status] : [];

  const built = buildListWhere(req, base, baseParams);
  if ('error' in built) return res.status(400).json(built);
  const { where, params } = built;

  const limit = clampLimit(req.query.limit);
  const offset = clampOffset(req.query.offset);

  try {
    const { rows: countRows } = await db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM nutrition_library_items WHERE ${where}`,
      params,
    );
    const total = countRows[0]?.total ?? 0;

    // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8's prepared-statement
    // protocol rejects a parameterised LIMIT (ER_WRONG_ARGUMENTS). limit/offset are
    // already validated integers (clampLimit/clampOffset), so direct interpolation is safe.
    const { rows } = await db.query<{ id: number; name: string; category: string; status: string; created_at: string; modified_at: string | null }>(
      `SELECT id, name, category, status, created_at, modified_at
       FROM nutrition_library_items
       WHERE ${where}
       ORDER BY name ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const qualitiesMap = await loadQualitiesMap(rows.map((r) => r.id));
    res.json({
      items: rows.map((r) => ({ ...r, qualities: qualitiesMap[r.id] ?? [] })),
      total,
      limit,
      offset,
    });
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

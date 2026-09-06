import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  CATEGORIES, Category,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  buildListWhere, clampLimit, clampOffset,
} from '../domain/nutritionLibrary';

export const nutritionLibraryRouter = Router();

/* ── Nutritional Qualities catalogue (read-only) ──────────────────────────── */

nutritionLibraryRouter.get('/nutritional-qualities', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, slug FROM nutritional_qualities ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── List ─────────────────────────────────────────────────────────────────── */
// System items (gym_id IS NULL) are always visible and read-only. Gym-owned
// items (gym_id = this gym) are visible and, with write access, editable.

nutritionLibraryRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const base = ['(gym_id IS NULL OR gym_id = ?)', "status != 'deleted'"];
  const baseParams: any[] = [gymId];

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
    const { rows } = await db.query<{ id: number; gym_id: string | null; name: string; category: string; status: string; created_at: string; modified_at: string | null }>(
      `SELECT id, gym_id, name, category, status, created_at, modified_at
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

/* ── Create (gym-owned items only) ───────────────────────────────────────── */

nutritionLibraryRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
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
      "SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name = ? AND category = ? AND status != 'deleted'",
      [gymId, name.trim(), category],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name and category already exists' });

    const { insertId } = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, category, status) VALUES (?, ?, ?, 'active')",
      [gymId, name.trim(), category],
    );

    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids);
    }

    const { rows } = await db.query(
      'SELECT id, gym_id, name, category, status, created_at, modified_at FROM nutrition_library_items WHERE id = ?',
      [insertId],
    );
    const qualitiesMap = await loadQualitiesMap([insertId]);
    const item = { ...rows[0], qualities: qualitiesMap[insertId] ?? [] };
    recordAudit(req, { action: 'create', entityType: 'nutrition_library_item', entityId: insertId, next: item });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

/* ── Update (gym-owned items only — system items are read-only here) ─────── */

nutritionLibraryRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
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
      'SELECT id, gym_id, name, category, status FROM nutrition_library_items WHERE id = ?',
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].gym_id === null) return res.status(403).json({ error: 'System library items are read-only' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    if (name?.trim()) {
      const resolvedCategory = category ?? existing[0].category;
      const { rows: conflict } = await db.query(
        "SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name = ? AND category = ? AND id != ? AND status != 'deleted'",
        [gymId, name.trim(), resolvedCategory, id],
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
      'SELECT id, gym_id, name, category, status, created_at, modified_at FROM nutrition_library_items WHERE id = ?',
      [id],
    );
    const qualitiesMap = await loadQualitiesMap([Number(id)]);
    const item = { ...rows[0], qualities: qualitiesMap[Number(id)] ?? [] };
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, previous: existing[0], next: item });
    res.json(item);
  } catch (err) { next(err); }
});

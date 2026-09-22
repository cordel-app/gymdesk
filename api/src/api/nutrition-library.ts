import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  loadCategoriesMap, replaceCategories, validateCategoryIds,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  loadTranslationsMap, localizedNameSql,
  buildListWhere, clampLimit, clampOffset,
} from '../domain/nutritionLibrary';
import { getRequestLocale } from '../infra/locale';

export const nutritionLibraryRouter = Router();

/* ── Categories catalogue (read-only) ────────────────────────────────────── */

nutritionLibraryRouter.get('/categories', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, slug FROM nutrition_library_categories ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

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
  const locale = getRequestLocale(req);
  const base = ['(gym_id IS NULL OR gym_id = ?)', "status != 'deleted'"];
  const baseParams: any[] = [gymId];

  const built = buildListWhere(req, base, baseParams, locale);
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
    // `name` stays the base (English) value — it is what edit forms submit back
    // and what uniqueness is enforced on. `display_name` is the same item in the
    // caller's locale, and is what every UI renders (#643).
    const { rows } = await db.query<{ id: number; gym_id: string | null; name: string; display_name: string; status: string; image_url: string | null; created_at: string; modified_at: string | null }>(
      `SELECT nli.id, nli.gym_id, nli.name, ${localizedNameSql('nli', locale)} AS display_name,
              nli.status, nli.image_url, nli.created_at, nli.modified_at
       FROM nutrition_library_items nli
       WHERE ${where}
       ORDER BY display_name ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const ids = rows.map((r) => r.id);
    const [categoriesMap, qualitiesMap, translationsMap] = await Promise.all([
      loadCategoriesMap(ids), loadQualitiesMap(ids), loadTranslationsMap(ids),
    ]);
    res.json({
      items: rows.map((r) => ({
        ...r,
        categories: categoriesMap[r.id] ?? [],
        qualities: qualitiesMap[r.id] ?? [],
        translations: translationsMap[r.id] ?? {},
      })),
      total,
      limit,
      offset,
    });
  } catch (err) { next(err); }
});

/* ── Create (gym-owned items only) ───────────────────────────────────────── */

nutritionLibraryRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, category_ids, quality_ids, image_url } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const catErr = await validateCategoryIds(category_ids);
  if (catErr) return res.status(400).json(catErr);
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name = ? AND status != 'deleted'",
      [gymId, name.trim()],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });

    const { insertId } = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, image_url, status) VALUES (?, ?, ?, 'active')",
      [gymId, name.trim(), image_url ?? null],
    );

    await replaceCategories(insertId, category_ids);
    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids);
    }

    const { rows } = await db.query(
      `SELECT nli.id, nli.gym_id, nli.name, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name,
              nli.status, nli.image_url, nli.created_at, nli.modified_at
       FROM nutrition_library_items nli WHERE nli.id = ?`,
      [insertId],
    );
    const [categoriesMap, qualitiesMap] = await Promise.all([loadCategoriesMap([insertId]), loadQualitiesMap([insertId])]);
    // Gym-owned items carry a single entered name shown in every locale (#643),
    // so a freshly created one never has translation rows.
    const item = { ...rows[0], categories: categoriesMap[insertId] ?? [], qualities: qualitiesMap[insertId] ?? [], translations: {} };
    recordAudit(req, { action: 'create', entityType: 'nutrition_library_item', entityId: insertId, next: item });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

/* ── Update (gym-owned items only — system items are read-only here) ─────── */

nutritionLibraryRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { id } = req.params;
  const { name, category_ids, quality_ids, image_url } = req.body;

  if (category_ids !== undefined) {
    const err = await validateCategoryIds(category_ids);
    if (err) return res.status(400).json(err);
  }
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
  }
  try {
    const { rows: existing } = await db.query(
      'SELECT id, gym_id, name, status FROM nutrition_library_items WHERE id = ?',
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].gym_id === null) return res.status(403).json({ error: 'System library items are read-only' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    if (name?.trim()) {
      const { rows: conflict } = await db.query(
        "SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name = ? AND id != ? AND status != 'deleted'",
        [gymId, name.trim(), id],
      );
      if (conflict.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });
    }

    const updates: string[] = ['modified_at = UTC_TIMESTAMP()'];
    const params: any[] = [];
    if (name?.trim())            { updates.push('name = ?');       params.push(name.trim()); }
    if ('image_url' in req.body) { updates.push('image_url = ?'); params.push(image_url ?? null); }

    params.push(id);
    await db.query(`UPDATE nutrition_library_items SET ${updates.join(', ')} WHERE id = ?`, params);

    if (Array.isArray(category_ids)) {
      await replaceCategories(Number(id), category_ids);
    }
    if (Array.isArray(quality_ids)) {
      await replaceQualities(Number(id), quality_ids);
    }

    const { rows } = await db.query(
      `SELECT nli.id, nli.gym_id, nli.name, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name,
              nli.status, nli.image_url, nli.created_at, nli.modified_at
       FROM nutrition_library_items nli WHERE nli.id = ?`,
      [id],
    );
    const [categoriesMap, qualitiesMap, translationsMap] = await Promise.all([
      loadCategoriesMap([Number(id)]), loadQualitiesMap([Number(id)]), loadTranslationsMap([Number(id)]),
    ]);
    const item = {
      ...rows[0],
      categories: categoriesMap[Number(id)] ?? [],
      qualities: qualitiesMap[Number(id)] ?? [],
      translations: translationsMap[Number(id)] ?? {},
    };
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, previous: existing[0], next: item });
    res.json(item);
  } catch (err) { next(err); }
});

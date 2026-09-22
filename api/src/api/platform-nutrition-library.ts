import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  loadCategoriesMap, replaceCategories, validateCategoryIds,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  loadTranslationsMap, replaceTranslations, validateTranslations, localizedNameSql,
  buildListWhere, clampLimit, clampOffset,
} from '../domain/nutritionLibrary';
import { getRequestLocale, SUPPORTED_LOCALES, BASE_LOCALE, TRANSLATABLE_LOCALES } from '../infra/locale';

export const platformNutritionLibraryRouter = Router();

/* ── Categories catalogue (read-only for now) ────────────────────────────── */

platformNutritionLibraryRouter.get('/categories', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, slug FROM nutrition_library_categories ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Nutritional Qualities catalogue (read-only for now) ─────────────────── */

platformNutritionLibraryRouter.get('/nutritional-qualities', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, slug FROM nutritional_qualities ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Supported locales (#643) ─────────────────────────────────────────────── */
// Lets the Cordel library page render exactly one name field per translatable
// locale instead of hardcoding the list a second time in the frontend.

platformNutritionLibraryRouter.get('/locales', requireSuperadmin, (_req, res) => {
  res.json({ locales: SUPPORTED_LOCALES, base_locale: BASE_LOCALE, translatable: TRANSLATABLE_LOCALES });
});

/* ── List ─────────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const status = req.query.status as string | undefined;
  const locale = getRequestLocale(req);
  const base = ['gym_id IS NULL', status ? 'status = ?' : "status != 'deleted'"];
  const baseParams = status ? [status] : [];

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
    // `name` is the base (English) value the edit form submits back; `display_name`
    // is the caller's locale and `translations` the full per-locale set, which
    // this page is where superadmins author (#643).
    const { rows } = await db.query<{ id: number; name: string; display_name: string; status: string; created_at: string; modified_at: string | null }>(
      `SELECT nli.id, nli.name, ${localizedNameSql('nli', locale)} AS display_name,
              nli.status, nli.created_at, nli.modified_at
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

/* ── Create ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, category_ids, quality_ids, translations } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const catErr = await validateCategoryIds(category_ids);
  if (catErr) return res.status(400).json(catErr);
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
  }
  if (translations !== undefined) {
    const err = validateTranslations(translations);
    if (err) return res.status(400).json(err);
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM nutrition_library_items WHERE gym_id IS NULL AND name = ? AND status != 'deleted'",
      [name.trim()],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });

    const { insertId } = await db.query(
      "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (NULL, ?, 'active')",
      [name.trim()],
    );

    await replaceCategories(insertId, category_ids);
    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids);
    }
    if (translations !== undefined) {
      await replaceTranslations(insertId, translations);
    }

    const { rows } = await db.query(
      `SELECT nli.id, nli.name, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name,
              nli.status, nli.created_at, nli.modified_at
       FROM nutrition_library_items nli WHERE nli.id = ?`,
      [insertId],
    );
    const [categoriesMap, qualitiesMap, translationsMap] = await Promise.all([
      loadCategoriesMap([insertId]), loadQualitiesMap([insertId]), loadTranslationsMap([insertId]),
    ]);
    const item = {
      ...rows[0],
      categories: categoriesMap[insertId] ?? [],
      qualities: qualitiesMap[insertId] ?? [],
      translations: translationsMap[insertId] ?? {},
    };
    recordAudit(req, { action: 'create', entityType: 'nutrition_library_item', entityId: insertId, next: item });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { name, category_ids, quality_ids, translations } = req.body;

  if (category_ids !== undefined) {
    const err = await validateCategoryIds(category_ids);
    if (err) return res.status(400).json(err);
  }
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
  }
  if (translations !== undefined) {
    const err = validateTranslations(translations);
    if (err) return res.status(400).json(err);
  }
  try {
    const { rows: existing } = await db.query(
      "SELECT id, name, status FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    if (name?.trim()) {
      const { rows: conflict } = await db.query(
        "SELECT id FROM nutrition_library_items WHERE gym_id IS NULL AND name = ? AND id != ? AND status != 'deleted'",
        [name.trim(), id],
      );
      if (conflict.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });
    }

    const updates: string[] = ['modified_at = UTC_TIMESTAMP()'];
    const params: any[] = [];
    if (name?.trim())  { updates.push('name = ?');     params.push(name.trim()); }

    params.push(id);
    await db.query(`UPDATE nutrition_library_items SET ${updates.join(', ')} WHERE id = ?`, params);

    if (Array.isArray(category_ids)) {
      await replaceCategories(Number(id), category_ids);
    }
    if (Array.isArray(quality_ids)) {
      await replaceQualities(Number(id), quality_ids);
    }
    if (translations !== undefined) {
      await replaceTranslations(Number(id), translations);
    }

    const { rows } = await db.query(
      `SELECT nli.id, nli.name, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name,
              nli.status, nli.created_at, nli.modified_at
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

/* ── Categories sub-resource ──────────────────────────────────────────────── */

platformNutritionLibraryRouter.put('/:id/categories', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { category_ids } = req.body;

  const err = await validateCategoryIds(category_ids);
  if (err) return res.status(400).json(err);

  try {
    const { rows: existing } = await db.query(
      "SELECT id, status FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    await replaceCategories(Number(id), category_ids);

    const categoriesMap = await loadCategoriesMap([Number(id)]);
    res.json({ item_id: Number(id), categories: categoriesMap[Number(id)] ?? [] });
  } catch (err) { next(err); }
});

/* ── Translations sub-resource (#643) ─────────────────────────────────────── */
// Same shape as the qualities/categories sub-resources: the payload is the
// complete per-locale set, so omitting a locale clears it back to the base name.

platformNutritionLibraryRouter.put('/:id/translations', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { translations } = req.body;

  const err = validateTranslations(translations);
  if (err) return res.status(400).json(err);

  try {
    const { rows: existing } = await db.query(
      "SELECT id, status FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    await replaceTranslations(Number(id), translations);

    const translationsMap = await loadTranslationsMap([Number(id)]);
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, next: { translations: translationsMap[Number(id)] ?? {} } });
    res.json({ item_id: Number(id), translations: translationsMap[Number(id)] ?? {} });
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

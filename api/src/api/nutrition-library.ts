import express, { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  loadCategoriesMap, replaceCategories, validateCategoryIds,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  loadTranslationsMap, localizedNameSql,
  buildListWhere, pagingClause,
  itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';
import {
  loadDescriptionTranslationsMap, localizedDescriptionSql,
  parseDescriptionTranslations, replaceDescriptionTranslations,
} from '../domain/nutritionDescriptionTranslations';
import { resolveRequestActor } from '../domain/auditActor';
import {
  buildGymNutritionImageKey,
  gymNutritionFolderKeys,
} from '../domain/baseNutritionImages';
import { getRequestLocale, TRANSLATABLE_LOCALES } from '../infra/locale';
import { buildStorageObjectUrl } from '../infra/storage';
import {
  isNutritionImageRefusal,
  nutritionImageBodyParser,
  nutritionImageUploadRateLimit,
  parseNutritionImageRequest,
  storeNutritionImagePair,
  sweepReplacedNutritionImage,
} from './nutrition-image-storage';
import { logger } from '../lib/logger';

export const nutritionLibraryRouter = Router();

/**
 * The columns every item-shaped response returns. `description` and the actor /
 * deletion snapshot (#799, migration 196) are part of it: the Details modal is
 * fed by the list row rather than by a second endpoint, so what it shows has to
 * come back here (#799 §25).
 *
 * `maskPlatformActors`: this router also returns the shared system rows
 * (`gym_id IS NULL`), which are administered from Cordel — so their actor names
 * are Cordel employees' and are not published to every tenant. A gym's own rows
 * carry theirs, and `created_at`/`modified_at` are returned either way.
 */
const ITEM_COLUMNS = `nli.id, nli.gym_id, nli.name, nli.status, nli.image_url,
  nli.created_at, nli.modified_at, ${itemDetailColumnsSql('nli', { maskPlatformActors: true })}`;

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

/* ── Languages a description can be translated into (#1720) ──────────────── */
// Same contract as `GET /platform/nutrition-library/locales`; registered before `/:id`.

nutritionLibraryRouter.get('/locales', (_req, res) => {
  res.json({ translatable: TRANSLATABLE_LOCALES });
});

/* ── List ─────────────────────────────────────────────────────────────────── */
// System items (gym_id IS NULL) are always visible and read-only. Gym-owned
// items (gym_id = this gym) are visible and, with write access, editable.

nutritionLibraryRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const locale = getRequestLocale(req);
  // `?status=deleted` (Show deleted, #1301) lists this gym's own soft-deleted items
  // only — a System row's deletion is Cordel's, never shown to a gym.
  const showDeleted = req.query.status === 'deleted';
  const base = showDeleted ? ['gym_id = ?', "status = 'deleted'"] : ['(gym_id IS NULL OR gym_id = ?)', "status != 'deleted'"];
  const baseParams: any[] = [gymId];

  const built = buildListWhere(req, base, baseParams, locale);
  if ('error' in built) return res.status(400).json(built);
  const { where, params } = built;

  const { clause: pagingSql, limit, offset } = pagingClause(req.query.limit, req.query.offset);

  try {
    const { rows: countRows } = await db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM nutrition_library_items WHERE ${where}`,
      params,
    );
    const total = countRows[0]?.total ?? 0;

    // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8's prepared-statement
    // protocol rejects a parameterised LIMIT (ER_WRONG_ARGUMENTS). limit/offset are
    // already validated integers (pagingClause), so direct interpolation is safe; `?limit=all` (#1302) omits the clause.
    // `name` stays the base (English) value — it is what edit forms submit back
    // and what uniqueness is enforced on. `display_name` is the same item in the
    // caller's locale, and is what every UI renders (#643).
    const { rows } = await db.query<{ id: number; gym_id: string | null; name: string; display_name: string; status: string; image_url: string | null; created_at: string; modified_at: string | null }>(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', locale)} AS display_name, ${localizedDescriptionSql('nli', locale)} AS display_description
       FROM nutrition_library_items nli
       WHERE ${where}
       ORDER BY display_name ASC
       ${pagingSql}`,
      params,
    );

    const ids = rows.map((r) => r.id);
    const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
      loadCategoriesMap(ids), loadQualitiesMap(ids), loadTranslationsMap(ids), loadDescriptionTranslationsMap(ids),
    ]);
    res.json({
      items: rows.map((r) => ({
        ...r,
        categories: categoriesMap[r.id] ?? [],
        qualities: qualitiesMap[r.id] ?? [],
        translations: translationsMap[r.id] ?? {},
        description_translations: descMap[r.id] ?? {},
      })),
      total,
      limit,
      offset,
    });
  } catch (err) { next(err); }
});

/* ── Create (gym-owned items only) ───────────────────────────────────────── */

nutritionLibraryRouter.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { name, category_ids, quality_ids, image_url } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const catErr = await validateCategoryIds(category_ids);
  if (catErr) return res.status(400).json(catErr);
  if (quality_ids !== undefined) {
    const err = await validateQualityIds(quality_ids);
    if (err) return res.status(400).json(err);
  }
  const description = normalizeDescription(req.body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const descTr = parseDescriptionTranslations(req.body);
  if (descTr.error) return res.status(400).json({ error: descTr.error });
  const actor = resolveRequestActor(ctx);
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name = ? AND status != 'deleted'",
      [gymId, name.trim()],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });

    const { insertId } = await db.query(
      `INSERT INTO nutrition_library_items
         (gym_id, name, description, image_url, status, created_by)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [gymId, name.trim(), description.value ?? null, image_url ?? null, actor],
    );

    await replaceCategories(insertId, category_ids);
    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids);
    }
    if (descTr.value !== undefined) {
      await db.transaction((conn) => replaceDescriptionTranslations(conn, insertId, descTr.value!));
    }

    const { rows } = await db.query(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name, ${localizedDescriptionSql('nli', getRequestLocale(req))} AS display_description
       FROM nutrition_library_items nli WHERE nli.id = ?`,
      [insertId],
    );
    const [categoriesMap, qualitiesMap, descMap] = await Promise.all([
      loadCategoriesMap([insertId]), loadQualitiesMap([insertId]), loadDescriptionTranslationsMap([insertId]),
    ]);
    // Gym-owned items carry a single entered name shown in every locale (#643),
    // so a freshly created one never has name translation rows; descriptions
    // are translated per locale (#1720).
    const item = {
      ...rows[0], categories: categoriesMap[insertId] ?? [], qualities: qualitiesMap[insertId] ?? [], translations: {},
      description_translations: descMap[insertId] ?? {},
    };
    recordAudit(req, { action: 'create', entityType: 'nutrition_library_item', entityId: insertId, next: item });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

/* ── Image upload (#1035 §4/§5) ───────────────────────────────────────────── */
//
// A gym food's image is an object in the gym's own folder, at the key the row's
// own id and name give it: `<storage_folder_prefix>/nutrition/<food_id>-<name>.<ext>`
// (`buildGymNutritionImageKey()`). It replaces `POST /storage/uploads/nutrition-image`,
// whose `<prefix>/Nutrition/Images/<uuid>.<ext>` key could carry neither the food's
// id nor its name — which is why this is a per-row route at all, and why the
// Nutrition Library's create form has no image control: the food exists first,
// then its image is uploaded from Edit (Cordel's Base library already works this
// way).
//
// The route takes neither the folder nor the key from the request: the prefix is
// the gym's own column, the food is looked up under this gym, and the name comes
// from the row. A client cannot reach another gym's folder, or another food's
// object, by changing anything it sends — and a System row (`gym_id IS NULL`) is
// 403 here exactly as it is on the `PUT`, because its image is Cordel's.
//
// The picture is converted on the server (#1562): whatever format the gym sends,
// the stored objects are a 1080 × 1080 WebP master and a 256 × 256 thumbnail.

nutritionLibraryRouter.post(
  '/:id/image',
  requireModuleWrite('NUTRITION'),
  nutritionImageUploadRateLimit,
  nutritionImageBodyParser,
  async (req, res, next) => {
    const ctx = getTenantContext(req);
    const { gymId } = ctx;
    const { id } = req.params;
    try {
      const { rows: existing } = await db.query<{ id: number; gym_id: string | null; name: string; status: string; image_url: string | null }>(
        'SELECT id, gym_id, name, status, image_url FROM nutrition_library_items WHERE id = ?',
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System library items are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Item not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

      const processed = await parseNutritionImageRequest(req);
      if (isNutritionImageRefusal(processed)) return res.status(processed.status).json(processed.body);

      const { rows: gymRows } = await db.query<{ storage_folder_prefix: string | null }>(
        'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
        [gymId],
      );
      const folderPrefix = gymRows[0]?.storage_folder_prefix ?? null;
      if (!folderPrefix) {
        return res.status(409).json({ error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.' });
      }

      const food = existing[0];
      const key = buildGymNutritionImageKey(folderPrefix, food.id, food.name);
      const url = buildStorageObjectUrl(key);

      const refusal = await storeNutritionImagePair({
        key,
        processed,
        folderKeys: gymNutritionFolderKeys(folderPrefix),
        currentUrl: food.image_url,
        logContext: { gymId, itemId: food.id },
      });
      if (refusal) return res.status(refusal.status).json(refusal.body);

      const staleUrl = food.image_url;
      const actor = resolveRequestActor(ctx);
      await db.query(
        `UPDATE nutrition_library_items
         SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
         WHERE id = ?`,
        [url, actor, food.id],
      );
      // Only an object under *this gym's* prefix is ever deleted, so a food
      // pointing at a `cordel/` System image or an external URL is left alone.
      await sweepReplacedNutritionImage(
        staleUrl, key, (k) => k.startsWith(`${folderPrefix}/`), { gymId, itemId: food.id },
      );

      const { rows } = await db.query(
        `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name, ${localizedDescriptionSql('nli', getRequestLocale(req))} AS display_description
         FROM nutrition_library_items nli WHERE nli.id = ?`,
        [food.id],
      );
      const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
        loadCategoriesMap([food.id]), loadQualitiesMap([food.id]), loadTranslationsMap([food.id]), loadDescriptionTranslationsMap([food.id]),
      ]);
      const item = {
        ...rows[0],
        categories: categoriesMap[food.id] ?? [],
        qualities: qualitiesMap[food.id] ?? [],
        translations: translationsMap[food.id] ?? {},
        description_translations: descMap[food.id] ?? {},
      };
      recordAudit(req, {
        action: 'update',
        entityType: 'nutrition_library_item',
        entityId: food.id,
        previous: { image_url: staleUrl },
        next: { image_url: url },
      });
      res.json(item);
    } catch (err) { next(err); }
  },
);

/* ── Update (gym-owned items only — system items are read-only here) ─────── */

nutritionLibraryRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
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
  const description = normalizeDescription(req.body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const descTr = parseDescriptionTranslations(req.body);
  if (descTr.error) return res.status(400).json({ error: descTr.error });
  const actor = resolveRequestActor(ctx);
  try {
    const { rows: existing } = await db.query(
      'SELECT id, gym_id, name, description, status FROM nutrition_library_items WHERE id = ?',
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

    // The actor pair moves with every edit, so `modified_by` always names
    // whoever `modified_at` refers to (#799 §13).
    const updates: string[] = [];
    const params: any[] = [actor];
    if (name?.trim())            { updates.push('name = ?');       params.push(name.trim()); }
    if ('image_url' in req.body) { updates.push('image_url = ?'); params.push(image_url ?? null); }
    // Absent from the body means "leave it alone"; an empty string means "clear it".
    if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }

    params.push(id);
    await db.query(`UPDATE nutrition_library_items SET modified_at = UTC_TIMESTAMP(), modified_by = ?${updates.map((u) => `, ${u}`).join('')} WHERE id = ?`, params);

    if (Array.isArray(category_ids)) {
      await replaceCategories(Number(id), category_ids);
    }
    if (Array.isArray(quality_ids)) {
      await replaceQualities(Number(id), quality_ids);
    }
    if (descTr.value !== undefined) {
      await db.transaction((conn) => replaceDescriptionTranslations(conn, Number(id), descTr.value!));
    }

    const { rows } = await db.query(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name, ${localizedDescriptionSql('nli', getRequestLocale(req))} AS display_description
       FROM nutrition_library_items nli WHERE nli.id = ?`,
      [id],
    );
    const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
      loadCategoriesMap([Number(id)]), loadQualitiesMap([Number(id)]), loadTranslationsMap([Number(id)]), loadDescriptionTranslationsMap([Number(id)]),
    ]);
    const item = {
      ...rows[0],
      categories: categoriesMap[Number(id)] ?? [],
      qualities: qualitiesMap[Number(id)] ?? [],
      translations: translationsMap[Number(id)] ?? {},
        description_translations: descMap[Number(id)] ?? {},
    };
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, previous: existing[0], next: item });
    res.json(item);
  } catch (err) { next(err); }
});

/* ── Soft delete (gym-owned items only, #1301) ───────────────────────────── */
// Mirrors the platform route: `status = 'deleted'` is the flag every query
// filters on; `deleted_at` and the actor pair record when and by whom.

nutritionLibraryRouter.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { id } = req.params;
  try {
    const { rows: existing } = await db.query(
      'SELECT id, gym_id, status FROM nutrition_library_items WHERE id = ?',
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].gym_id === null) return res.status(403).json({ error: 'System library items are read-only' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is already deleted' });

    const actor = resolveRequestActor(ctx);
    await db.query(
      `UPDATE nutrition_library_items
       SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ?,
           modified_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id = ?`,
      [actor, id, gymId],
    );
    recordAudit(req, { action: 'delete', entityType: 'nutrition_library_item', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

import { Router } from 'express';
import express from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  loadCategoriesMap, replaceCategories, validateCategoryIds,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  loadTranslationsMap, replaceTranslations, validateTranslations, localizedNameSql,
  buildListWhere, pagingClause,
  itemDetailColumnsSql, normalizeDescription, BASE_FOOD_TABLES,
} from '../domain/nutritionLibrary';
import {
  loadDescriptionTranslationsMap, localizedDescriptionSql,
  parseDescriptionTranslations, replaceDescriptionTranslations,
} from '../domain/nutritionDescriptionTranslations';
import { resolvePlatformActor } from '../domain/auditActor';
import {
  PLATFORM_NUTRITION_PREFIX,
  baseNutritionFolderKeys,
  buildBaseNutritionImageKey,
} from '../domain/baseNutritionImages';
import { buildStorageObjectUrl } from '../infra/storage';
import {
  isNutritionImageRefusal,
  nutritionImageBodyParser,
  nutritionImageUploadRateLimit,
  parseNutritionImageRequest,
  storeNutritionImagePair,
  sweepReplacedNutritionImage,
} from './nutrition-image-storage';
import { mirrorFoodToLegacy } from './base-food-mirror';
import { getRequestLocale, SUPPORTED_LOCALES, BASE_LOCALE, TRANSLATABLE_LOCALES } from '../infra/locale';

/**
 * #1849 stage F2 — Cordel's Base Foods, on `base_nutrition_library_items` and its
 * four junctions. Personal Goals' 2b / Nutrition Goals' N2 one catalogue over.
 *
 * Until the gym side moves onto the Base tables every write here is **mirrored onto
 * the legacy System row of the same id** (`mirrorFoodToLegacy()`): the gym-facing
 * router and the plan tables still reference the legacy row by id. A new food takes
 * its id from `nutrition_library_items` first (gyms still create their own foods
 * there), then the Base row is inserted under that id, so the two cannot collide.
 * Response shapes are the ones this router always served (`status` active|deleted,
 * derived here from `deleted_at`).
 */
export const platformNutritionLibraryRouter = Router();

/**
 * The columns every item-shaped response returns. `image_url` (#715) is the
 * existing column migration 138 added for gym-owned items, reused rather than
 * doubled: a base food's URL points at `cordel/nutrition/…`, a gym food's at its
 * own folder, and the ownership of the row is what decides which — see
 * `domain/baseNutritionImages.ts`.
 */
const ITEM_COLUMNS = `nli.id, nli.name, IF(nli.deleted_at IS NULL, 'active', 'deleted') AS status, nli.image_url, nli.created_at, nli.modified_at,
  ${itemDetailColumnsSql('nli')}`;

/**
 * Every write on this router is a superadmin's, by `requireSuperadmin` — the
 * actor is the superadmin's own name (#799 §13, #1182).
 */
function platformActor(req: { superadminName?: string | null }) {
  return resolvePlatformActor(req.superadminName);
}

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
  // Base rows have no `status`: it is derived from `deleted_at` (a requested 'deleted' lists the soft-deleted).
  const base = [status === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const baseParams: any[] = [];

  const built = buildListWhere(req, base, baseParams, locale, BASE_FOOD_TABLES);
  if ('error' in built) return res.status(400).json(built);
  const { where, params } = built;

  const { clause: pagingSql, limit, offset } = pagingClause(req.query.limit, req.query.offset);

  try {
    const { rows: countRows } = await db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM base_nutrition_library_items WHERE ${where}`,
      params,
    );
    const total = countRows[0]?.total ?? 0;

    // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8's prepared-statement
    // protocol rejects a parameterised LIMIT (ER_WRONG_ARGUMENTS). limit/offset are
    // already validated integers (pagingClause), so direct interpolation is safe; `?limit=all` (#1302) omits the clause.
    // `name` is the base (English) value the edit form submits back; `display_name`
    // is the caller's locale and `translations` the full per-locale set, which
    // this page is where superadmins author (#643).
    const { rows } = await db.query<{ id: number; name: string; display_name: string; status: string; image_url: string | null; created_at: string; modified_at: string | null }>(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', locale, BASE_FOOD_TABLES)} AS display_name, ${localizedDescriptionSql('nli', locale, BASE_FOOD_TABLES)} AS display_description
       FROM base_nutrition_library_items nli
       WHERE ${where}
       ORDER BY display_name ASC
       ${pagingSql}`,
      params,
    );

    const ids = rows.map((r) => r.id);
    const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
      loadCategoriesMap(ids, BASE_FOOD_TABLES), loadQualitiesMap(ids, BASE_FOOD_TABLES), loadTranslationsMap(ids, BASE_FOOD_TABLES), loadDescriptionTranslationsMap(ids, BASE_FOOD_TABLES),
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

/* ── Create ───────────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const { name, category_ids, quality_ids, translations } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const description = normalizeDescription(req.body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const descTr = parseDescriptionTranslations(req.body);
  if (descTr.error) return res.status(400).json({ error: descTr.error });
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
      "SELECT id FROM base_nutrition_library_items WHERE name = ? AND deleted_at IS NULL",
      [name.trim()],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });

    const actor = platformActor(req);
    const { insertId } = await db.query(
      `INSERT INTO nutrition_library_items
         (gym_id, name, description, status, created_by)
       VALUES (NULL, ?, ?, 'active', ?)`,
      [name.trim(), description.value ?? null, actor],
    );
    await db.query(
      `INSERT INTO base_nutrition_library_items (id, name, description, created_by) VALUES (?, ?, ?, ?)`,
      [insertId, name.trim(), description.value ?? null, actor],
    );

    await replaceCategories(insertId, category_ids, BASE_FOOD_TABLES);
    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids, BASE_FOOD_TABLES);
    }
    if (translations !== undefined) {
      await replaceTranslations(insertId, translations, BASE_FOOD_TABLES);
    }
    if (descTr.value !== undefined) {
      await db.transaction((conn) => replaceDescriptionTranslations(conn, insertId, descTr.value!, BASE_FOOD_TABLES));
    }
    await mirrorFoodToLegacy(insertId);

    const { rows } = await db.query(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req), BASE_FOOD_TABLES)} AS display_name, ${localizedDescriptionSql('nli', getRequestLocale(req), BASE_FOOD_TABLES)} AS display_description
       FROM base_nutrition_library_items nli WHERE nli.id = ?`,
      [insertId],
    );
    const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
      loadCategoriesMap([insertId], BASE_FOOD_TABLES), loadQualitiesMap([insertId], BASE_FOOD_TABLES), loadTranslationsMap([insertId], BASE_FOOD_TABLES), loadDescriptionTranslationsMap([insertId], BASE_FOOD_TABLES),
    ]);
    const item = {
      ...rows[0],
      categories: categoriesMap[insertId] ?? [],
      qualities: qualitiesMap[insertId] ?? [],
      translations: translationsMap[insertId] ?? {},
        description_translations: descMap[insertId] ?? {},
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
  const description = normalizeDescription(req.body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const descTr = parseDescriptionTranslations(req.body);
  if (descTr.error) return res.status(400).json({ error: descTr.error });
  try {
    const { rows: existing } = await db.query(
      "SELECT id, name, description, IF(deleted_at IS NULL, 'active', 'deleted') AS status FROM base_nutrition_library_items WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    if (name?.trim()) {
      const { rows: conflict } = await db.query(
        "SELECT id FROM base_nutrition_library_items WHERE name = ? AND id != ? AND deleted_at IS NULL",
        [name.trim(), id],
      );
      if (conflict.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });
    }

    // The actor pair moves with every edit, so `modified_by` always names
    // whoever `modified_at` refers to (#799 §13).
    const actor = platformActor(req);
    const updates: string[] = [];
    const params: any[] = [actor];
    if (name?.trim())  { updates.push('name = ?');     params.push(name.trim()); }
    // Absent from the body means "leave it alone"; an empty string means "clear it".
    if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }

    params.push(id);
    await db.query(`UPDATE base_nutrition_library_items SET modified_at = UTC_TIMESTAMP(), modified_by = ?${updates.map((u) => `, ${u}`).join('')} WHERE id = ?`, params);

    if (Array.isArray(category_ids)) {
      await replaceCategories(Number(id), category_ids, BASE_FOOD_TABLES);
    }
    if (Array.isArray(quality_ids)) {
      await replaceQualities(Number(id), quality_ids, BASE_FOOD_TABLES);
    }
    if (translations !== undefined) {
      await replaceTranslations(Number(id), translations, BASE_FOOD_TABLES);
    }
    if (descTr.value !== undefined) {
      await db.transaction((conn) => replaceDescriptionTranslations(conn, Number(id), descTr.value!, BASE_FOOD_TABLES));
    }
    await mirrorFoodToLegacy(String(id));

    const { rows } = await db.query(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req), BASE_FOOD_TABLES)} AS display_name, ${localizedDescriptionSql('nli', getRequestLocale(req), BASE_FOOD_TABLES)} AS display_description
       FROM base_nutrition_library_items nli WHERE nli.id = ?`,
      [id],
    );
    const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
      loadCategoriesMap([Number(id)], BASE_FOOD_TABLES), loadQualitiesMap([Number(id)], BASE_FOOD_TABLES), loadTranslationsMap([Number(id)], BASE_FOOD_TABLES), loadDescriptionTranslationsMap([Number(id)], BASE_FOOD_TABLES),
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

/* ── Qualities sub-resource ───────────────────────────────────────────────── */

platformNutritionLibraryRouter.put('/:id/qualities', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  const { quality_ids } = req.body;

  const err = await validateQualityIds(quality_ids);
  if (err) return res.status(400).json(err);

  try {
    const { rows: existing } = await db.query(
      "SELECT id, IF(deleted_at IS NULL, 'active', 'deleted') AS status FROM base_nutrition_library_items WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    await replaceQualities(Number(id), quality_ids, BASE_FOOD_TABLES);
    await mirrorFoodToLegacy(String(id));

    const qualitiesMap = await loadQualitiesMap([Number(id)], BASE_FOOD_TABLES);
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
      "SELECT id, IF(deleted_at IS NULL, 'active', 'deleted') AS status FROM base_nutrition_library_items WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    await replaceCategories(Number(id), category_ids, BASE_FOOD_TABLES);
    await mirrorFoodToLegacy(String(id));

    const categoriesMap = await loadCategoriesMap([Number(id)], BASE_FOOD_TABLES);
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
      "SELECT id, IF(deleted_at IS NULL, 'active', 'deleted') AS status FROM base_nutrition_library_items WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

    await replaceTranslations(Number(id), translations, BASE_FOOD_TABLES);
    await mirrorFoodToLegacy(String(id));

    const translationsMap = await loadTranslationsMap([Number(id)], BASE_FOOD_TABLES);
    recordAudit(req, { action: 'update', entityType: 'nutrition_library_item', entityId: id, next: { translations: translationsMap[Number(id)] ?? {} } });
    res.json({ item_id: Number(id), translations: translationsMap[Number(id)] ?? {} });
  } catch (err) { next(err); }
});

/* ── Image upload (#715) ──────────────────────────────────────────────────── */
//
// A Base Nutrition Library food is a `gym_id IS NULL` row and belongs to no gym,
// so its image cannot hang off `gyms.storage_folder_prefix`. It goes in the
// platform's own R2 folder, at the key the row's own id and name give it,
// `cordel/nutrition/<food_id>-<sanitized name>.png` (#715 §1, §9–§11; #1035 §12
// made it the food's id rather than a UUID per upload).
//
// The route takes neither the folder nor the key from the request: the prefix is
// the `cordel` constant, the food is looked up with `gym_id IS NULL` (so a
// gym-owned item is simply 404 here, whoever asks) and the key is built from
// the row's own name and a UUID the server generates. A client cannot reach
// another food's object, or a gym's folder, by changing anything it sends.
//
// Validation is the file's, not the request's (§8): PNG signature, 512×512 from
// the IHDR, and an alpha channel. Nothing is uploaded and nothing is written
// until all three pass, which is how "an invalid upload does not replace or
// delete the existing image" holds.

platformNutritionLibraryRouter.post(
  '/:id/image',
  requireSuperadmin,
  nutritionImageUploadRateLimit,
  nutritionImageBodyParser,
  async (req, res, next) => {
    try {
      const { rows: existing } = await db.query<{ id: number; name: string; status: string; image_url: string | null }>(
        "SELECT id, name, IF(deleted_at IS NULL, 'active', 'deleted') AS status, image_url FROM base_nutrition_library_items WHERE id = ?",
        [req.params.id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

      // The picture is judged and converted before anything is uploaded or
      // written, so a refused upload leaves the current image untouched.
      const processed = await parseNutritionImageRequest(req);
      if (isNutritionImageRefusal(processed)) return res.status(processed.status).json(processed.body);

      const food = existing[0];
      const key = buildBaseNutritionImageKey(food.id, food.name);
      const url = buildStorageObjectUrl(key);

      const refusal = await storeNutritionImagePair({
        key,
        processed,
        folderKeys: baseNutritionFolderKeys(),
        currentUrl: food.image_url,
        logContext: { itemId: food.id },
      });
      if (refusal) return res.status(refusal.status).json(refusal.body);

      // Only after both files are stored does the row move; the replaced objects
      // are swept afterwards, best-effort, and only under `cordel/nutrition/`.
      const staleUrl = food.image_url;
      const actor = platformActor(req);
      await db.query(
        `UPDATE base_nutrition_library_items
         SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
         WHERE id = ?`,
        [url, actor, food.id],
      );
      await mirrorFoodToLegacy(food.id);
      await sweepReplacedNutritionImage(
        staleUrl, key, (k) => k.toLowerCase().startsWith(`${PLATFORM_NUTRITION_PREFIX}/`), { itemId: food.id },
      );

      const { rows } = await db.query(
        `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req), BASE_FOOD_TABLES)} AS display_name, ${localizedDescriptionSql('nli', getRequestLocale(req), BASE_FOOD_TABLES)} AS display_description
         FROM base_nutrition_library_items nli WHERE nli.id = ?`,
        [food.id],
      );
      const [categoriesMap, qualitiesMap, translationsMap, descMap] = await Promise.all([
        loadCategoriesMap([food.id], BASE_FOOD_TABLES), loadQualitiesMap([food.id], BASE_FOOD_TABLES), loadTranslationsMap([food.id], BASE_FOOD_TABLES), loadDescriptionTranslationsMap([food.id], BASE_FOOD_TABLES),
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

/* ── Soft delete ──────────────────────────────────────────────────────────── */

platformNutritionLibraryRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  const { id } = req.params;
  try {
    const { rows: existing } = await db.query(
      "SELECT id, IF(deleted_at IS NULL, 'active', 'deleted') AS status FROM base_nutrition_library_items WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is already deleted' });

    // `status = 'deleted'` stays the flag every query filters on; `deleted_at`
    // and the actor pair record when and by whom, which the Details modal shows
    // (#799 §13, migration 196).
    const actor = platformActor(req);
    await db.query(
      `UPDATE base_nutrition_library_items
       SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, modified_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [actor, id],
    );
    await mirrorFoodToLegacy(String(id));
    recordAudit(req, { action: 'delete', entityType: 'nutrition_library_item', entityId: id });
    res.status(204).send();
  } catch (err) { next(err); }
});

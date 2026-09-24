import { Router } from 'express';
import express from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  loadCategoriesMap, replaceCategories, validateCategoryIds,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  loadTranslationsMap, replaceTranslations, validateTranslations, localizedNameSql,
  buildListWhere, clampLimit, clampOffset,
} from '../domain/nutritionLibrary';
import {
  BASE_NUTRITION_IMAGE_MAX_BYTES,
  BASE_NUTRITION_IMAGE_MIME,
  BASE_NUTRITION_IMAGE_REJECTION_MESSAGES,
  baseNutritionFolderKeys,
  buildBaseNutritionImageKey,
  validateBaseNutritionImage,
} from '../domain/baseNutritionImages';
import {
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  buildStorageObjectUrl,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';
import { getRequestLocale, SUPPORTED_LOCALES, BASE_LOCALE, TRANSLATABLE_LOCALES } from '../infra/locale';

export const platformNutritionLibraryRouter = Router();

/**
 * The columns every item-shaped response returns. `image_url` (#715) is the
 * existing column migration 138 added for gym-owned items, reused rather than
 * doubled: a base food's URL points at `cordel/Nutrition/…`, a gym food's at its
 * own folder, and the ownership of the row is what decides which — see
 * `domain/baseNutritionImages.ts`.
 */
const ITEM_COLUMNS = `nli.id, nli.name, nli.status, nli.image_url, nli.created_at, nli.modified_at`;

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
    const { rows } = await db.query<{ id: number; name: string; display_name: string; status: string; image_url: string | null; created_at: string; modified_at: string | null }>(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', locale)} AS display_name
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
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name
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
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name
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

/* ── Image upload (#715) ──────────────────────────────────────────────────── */
//
// A Base Nutrition Library food is a `gym_id IS NULL` row and belongs to no gym,
// so its image cannot hang off `gyms.storage_folder_prefix`. It goes in the
// platform's own R2 folder, under the deterministic key
// `cordel/Nutrition/<food_id>-<sanitized name>.png` (#715 §1, §9–§11).
//
// The route takes neither the folder nor the key from the request: the prefix is
// the `cordel` constant, the food is looked up with `gym_id IS NULL` (so a
// gym-owned item is simply 404 here, whoever asks) and the key is derived from
// the row's own id and name. A client cannot reach another food's object, or a
// gym's folder, by changing anything it sends.
//
// Validation is the file's, not the request's (§8): PNG signature, 512×512 from
// the IHDR, and an alpha channel. Nothing is uploaded and nothing is written
// until all three pass, which is how "an invalid upload does not replace or
// delete the existing image" holds.

platformNutritionLibraryRouter.post(
  '/:id/image',
  requireSuperadmin,
  express.raw({
    type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'),
    limit: BASE_NUTRITION_IMAGE_MAX_BYTES + 64 * 1024,
  }),
  async (req, res, next) => {
    try {
      const mime = req.headers['content-type']?.split(';')[0]?.trim();
      if (mime !== BASE_NUTRITION_IMAGE_MIME) {
        return res.status(415).json({ error: `Unsupported image type. Allowed: ${BASE_NUTRITION_IMAGE_MIME}` });
      }
      // `req.body` is whatever a parser left there, and a request can make that
      // a string or an array — both carry a `length` and numeric indices, so
      // they would flow into the size and signature checks as if they were bytes
      // (CodeQL `js/type-confusion-through-parameter-tampering`).
      const raw: unknown = req.body;
      if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
        return res.status(400).json({ error: 'Request body must be raw image bytes' });
      }
      const body: Buffer = raw;
      if (body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
      if (body.length > BASE_NUTRITION_IMAGE_MAX_BYTES) {
        return res.status(413).json({ error: `Image exceeds ${BASE_NUTRITION_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` });
      }
      const rejection = validateBaseNutritionImage(body);
      if (rejection) {
        return res.status(400).json({ error: BASE_NUTRITION_IMAGE_REJECTION_MESSAGES[rejection], reason: rejection });
      }

      if (!isStorageConfigured()) {
        const missingConfig = getMissingStorageConfigKeys();
        return res.status(503).json({
          error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
          missingConfig,
        });
      }

      const { rows: existing } = await db.query<{ id: number; name: string; status: string; image_url: string | null }>(
        'SELECT id, name, status, image_url FROM nutrition_library_items WHERE id = ? AND gym_id IS NULL',
        [req.params.id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

      const food = existing[0];
      const key = buildBaseNutritionImageKey(food.id, food.name);
      const url = buildStorageObjectUrl(key);

      try {
        await ensureStorageFolders(baseNutritionFolderKeys());
        await uploadStorageObject(key, BASE_NUTRITION_IMAGE_MIME, body);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'uploadStorageObject', key });
        logger.error(
          { err, details, diagnostics: getStorageDiagnostics(), itemId: food.id },
          'Cloudflare R2 base nutrition image upload failed',
        );
        // The row still points at whatever it pointed at before, so the previous
        // image stays visible — nothing was written.
        return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
      }

      // The key is deterministic, so a replacement normally overwrites the
      // object it replaces and there is nothing to orphan. The exception is a
      // food renamed since its last upload: the derived key moved, so the row's
      // old object is now unreachable. Removing it is best-effort and happens
      // *after* the new object is safely stored — a failure here leaves an
      // orphan to sweep, not a failed save.
      const staleUrl = food.image_url;
      if (staleUrl && url && staleUrl !== url) {
        const staleKey = storageKeyFromObjectUrl(staleUrl);
        if (staleKey && staleKey !== key) {
          try {
            await deleteStorageObject(staleKey);
          } catch (err: any) {
            const details = err instanceof StorageOperationError
              ? err.details
              : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
            logger.warn(
              { err, details, itemId: food.id },
              'Replaced base nutrition image left an orphaned object in Cloudflare R2',
            );
          }
        }
      }

      await db.query(
        'UPDATE nutrition_library_items SET image_url = ?, modified_at = UTC_TIMESTAMP() WHERE id = ?',
        [url, food.id],
      );

      const { rows } = await db.query(
        `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name
         FROM nutrition_library_items nli WHERE nli.id = ?`,
        [food.id],
      );
      const [categoriesMap, qualitiesMap, translationsMap] = await Promise.all([
        loadCategoriesMap([food.id]), loadQualitiesMap([food.id]), loadTranslationsMap([food.id]),
      ]);
      const item = {
        ...rows[0],
        categories: categoriesMap[food.id] ?? [],
        qualities: qualitiesMap[food.id] ?? [],
        translations: translationsMap[food.id] ?? {},
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

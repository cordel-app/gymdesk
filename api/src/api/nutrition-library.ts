import express, { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  loadCategoriesMap, replaceCategories, validateCategoryIds,
  loadQualitiesMap, replaceQualities, validateQualityIds,
  loadTranslationsMap, localizedNameSql,
  buildListWhere, pagingClause,
  actorSnapshot, itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';
import {
  buildGymNutritionImageKey,
  gymNutritionFolderKeys,
} from '../domain/baseNutritionImages';
import { getRequestLocale } from '../infra/locale';
import {
  buildStorageObjectUrl,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  storageKeyFromObjectUrl,
  StorageOperationError,
  uploadStorageObject,
} from '../infra/storage';
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
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', locale)} AS display_name
       FROM nutrition_library_items nli
       WHERE ${where}
       ORDER BY display_name ASC
       ${pagingSql}`,
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
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
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
  const actor = actorSnapshot({ name: actorName, isSuperadmin });
  try {
    const { rows: existing } = await db.query(
      "SELECT id FROM nutrition_library_items WHERE gym_id = ? AND name = ? AND status != 'deleted'",
      [gymId, name.trim()],
    );
    if (existing.length > 0) return res.status(409).json({ error: 'An item with this name already exists' });

    const { insertId } = await db.query(
      `INSERT INTO nutrition_library_items
         (gym_id, name, description, image_url, status, created_by_name, created_by_type)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [gymId, name.trim(), description.value ?? null, image_url ?? null, actor.name, actor.type],
    );

    await replaceCategories(insertId, category_ids);
    if (Array.isArray(quality_ids) && quality_ids.length > 0) {
      await replaceQualities(insertId, quality_ids);
    }

    const { rows } = await db.query(
      `SELECT ${ITEM_COLUMNS}, ${localizedNameSql('nli', getRequestLocale(req))} AS display_name
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
// What counts as valid is deliberately unchanged from the route this replaces:
// the same four MIME types at the same 5 MB ceiling, so the JPEGs a gym uploads
// today keep working. The extension therefore comes from the validated MIME type
// rather than being a fixed `.png`.

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

nutritionLibraryRouter.post(
  '/:id/image',
  requireModuleWrite('NUTRITION'),
  express.raw({
    type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'),
    limit: IMAGE_MAX_BYTES + 64 * 1024,
  }),
  async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const { id } = req.params;
    try {
      const mime = req.headers['content-type']?.split(';')[0]?.trim();
      if (!mime || !IMAGE_MIME_TYPES.includes(mime)) {
        return res.status(415).json({ error: `Unsupported image type. Allowed: ${IMAGE_MIME_TYPES.join(', ')}` });
      }
      // `req.body` is whatever a parser left there, and a request can make that a
      // string or an array — both carry a `length` and numeric indices, so they
      // would flow into the size check as if they were bytes (CodeQL
      // `js/type-confusion-through-parameter-tampering`).
      const raw: unknown = req.body;
      if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
        return res.status(400).json({ error: 'Request body must be raw image bytes' });
      }
      const body: Buffer = raw;
      if (body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
      if (body.length > IMAGE_MAX_BYTES) {
        return res.status(413).json({ error: `Image exceeds ${IMAGE_MAX_BYTES / (1024 * 1024)}MB limit` });
      }

      if (!isStorageConfigured()) {
        const missingConfig = getMissingStorageConfigKeys();
        return res.status(503).json({
          error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
          missingConfig,
        });
      }

      const { rows: existing } = await db.query<{ id: number; gym_id: string | null; name: string; status: string; image_url: string | null }>(
        'SELECT id, gym_id, name, status, image_url FROM nutrition_library_items WHERE id = ?',
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System library items are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Item not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Item is deleted' });

      const { rows: gymRows } = await db.query<{ storage_folder_prefix: string | null }>(
        'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
        [gymId],
      );
      const folderPrefix = gymRows[0]?.storage_folder_prefix ?? null;
      if (!folderPrefix) {
        return res.status(409).json({ error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.' });
      }

      const food = existing[0];
      const key = buildGymNutritionImageKey(folderPrefix, food.id, food.name, mime);
      const url = buildStorageObjectUrl(key);

      try {
        await ensureStorageFolders(gymNutritionFolderKeys(folderPrefix));
        await uploadStorageObject(key, mime, body);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'uploadStorageObject', key });
        logger.error(
          { err, details, diagnostics: getStorageDiagnostics(), gymId, itemId: food.id },
          'Cloudflare R2 nutrition image upload failed',
        );
        // The row still points at whatever it pointed at before, so the previous
        // image stays visible — nothing was written.
        return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
      }

      // The key is deterministic, so a replacement normally writes the same
      // object and there is nothing to remove. `staleKey !== key` is what a
      // rename, a different format, or an image still under the pre-#1035
      // `Nutrition/Images/<uuid>` shape answers true for. Best-effort and after
      // the new object is stored: a failure here leaves an orphan to sweep, not
      // a failed save. Only an object under *this gym's* prefix is ever deleted,
      // so a food pointing at a `cordel/` System image (or an external URL) is
      // left alone — #719 §19's rule, one table over.
      const staleUrl = food.image_url;
      const staleKey = staleUrl ? storageKeyFromObjectUrl(staleUrl) : null;
      if (staleKey && staleKey !== key && staleKey.startsWith(`${folderPrefix}/`)) {
        try {
          await deleteStorageObject(staleKey);
        } catch (err: any) {
          const details = err instanceof StorageOperationError
            ? err.details
            : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
          logger.warn(
            { err, details, gymId, itemId: food.id },
            'Replaced nutrition image left an orphaned object in Cloudflare R2',
          );
        }
      }

      const actor = actorSnapshot({ name: actorName, isSuperadmin });
      await db.query(
        `UPDATE nutrition_library_items
         SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by_name = ?, modified_by_type = ?
         WHERE id = ?`,
        [url, actor.name, actor.type, food.id],
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

/* ── Update (gym-owned items only — system items are read-only here) ─────── */

nutritionLibraryRouter.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
  const { gymId, actorName, isSuperadmin } = getTenantContext(req);
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
  const actor = actorSnapshot({ name: actorName, isSuperadmin });
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

    // The actor pair moves with every edit, so `modified_by_name` always names
    // whoever `modified_at` refers to (#799 §13).
    const updates: string[] = [
      'modified_at = UTC_TIMESTAMP()',
      'modified_by_name = ?',
      'modified_by_type = ?',
    ];
    const params: any[] = [actor.name, actor.type];
    if (name?.trim())            { updates.push('name = ?');       params.push(name.trim()); }
    if ('image_url' in req.body) { updates.push('image_url = ?'); params.push(image_url ?? null); }
    // Absent from the body means "leave it alone"; an empty string means "clear it".
    if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }

    params.push(id);
    await db.query(`UPDATE nutrition_library_items SET ${updates.join(', ')} WHERE id = ?`, params);

    if (Array.isArray(category_ids)) {
      await replaceCategories(Number(id), category_ids);
    }
    if (Array.isArray(quality_ids)) {
      await replaceQualities(Number(id), quality_ids);
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

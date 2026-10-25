// The one place a Base Product's image is written to and cleared from
// Cloudflare R2 (#2009 stage 3), under `cordel/base_products/`. Request parsing,
// WebP processing, the upload limiter and the 409 for an uninitialized bucket are
// the Member photo's (`member-image-storage.ts`) and are imported, not copied.
//
// A gym's imported Product holds the template's image *URLs* (stage 2 copies by
// reference), so a template's object is shared with `products` rows: it is never
// overwritten (a replacement always takes a timestamped variant) and never
// deleted while any `products` or other `base_products` row still points at it.

import { db } from '../infra/db';
import {
  baseProductImageFolderKeys,
  buildBaseProductImageKey,
  buildBaseProductImageThumbnailKey,
  isBaseProductImageUrl,
} from '../domain/baseProductImages';
import { MEMBER_IMAGE_STORED_MIME } from '../domain/memberImages';
import type { ProcessedMemberImage } from '../domain/memberImageProcessing';
import type { MemberImageRefusal } from './member-image-storage';
import {
  buildStorageObjectUrl,
  copyStorageObject,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  storageKeyFromObjectUrl,
  storageObjectUrlForms,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';

export interface BaseProductImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const BASE_PRODUCT_IMAGE_COLUMNS = 'id, name, image_url, image_thumbnail_url';

/** Whether any row other than this template — a gym Product or another template — points at `key` under any URL form. */
export async function isBaseProductImageKeyShared(baseProductId: number | string, key: string | null): Promise<boolean> {
  if (!key) return false;
  const forms = storageObjectUrlForms(key);
  if (forms.length === 0) return false;
  const marks = forms.map(() => '?').join(', ');
  const { rows: gymRows } = await db.query(
    `SELECT id FROM products WHERE image_url IN (${marks}) OR image_thumbnail_url IN (${marks}) LIMIT 1`,
    [...forms, ...forms],
  );
  if (gymRows.length > 0) return true;
  const { rows } = await db.query(
    `SELECT id FROM base_products WHERE id <> ? AND (image_url IN (${marks}) OR image_thumbnail_url IN (${marks})) LIMIT 1`,
    [baseProductId, ...forms, ...forms],
  );
  return rows.length > 0;
}

/** Best-effort removal of an object the template stopped pointing at, after the row moved. */
async function sweepReplacedImage(
  baseProductId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isBaseProductImageUrl(staleUrl)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  if (await isBaseProductImageKeyShared(baseProductId, staleKey)) return;
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, baseProductId }, 'Replaced base product image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail under the template's keys, then points the row at
 * both in one `UPDATE`. A 502 refusal leaves the row on what it had before.
 */
export async function storeBaseProductImage(args: {
  baseProduct: BaseProductImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { baseProduct, images, modifiedBy } = args;
  const plainKey = buildBaseProductImageKey(baseProduct.id, baseProduct.name);
  const plainThumbKey = buildBaseProductImageThumbnailKey(baseProduct.id, baseProduct.name);
  const shared = (await isBaseProductImageKeyShared(baseProduct.id, plainKey))
    || (await isBaseProductImageKeyShared(baseProduct.id, plainThumbKey))
    || (!!baseProduct.image_url && storageKeyFromObjectUrl(baseProduct.image_url) === plainKey);
  const variant = shared ? String(Date.now()) : undefined;
  const key = buildBaseProductImageKey(baseProduct.id, baseProduct.name, variant);
  const thumbnailKey = buildBaseProductImageThumbnailKey(baseProduct.id, baseProduct.name, variant);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(baseProductImageFolderKeys());
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), baseProductId: baseProduct.id },
      'Cloudflare R2 base product image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE base_products SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [url, thumbnailUrl, modifiedBy, baseProduct.id],
  );
  await sweepReplacedImage(baseProduct.id, baseProduct.image_url, url);
  await sweepReplacedImage(baseProduct.id, baseProduct.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the template's own objects unless a Product still shows them. */
export async function clearBaseProductImage(args: {
  baseProduct: BaseProductImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { baseProduct, modifiedBy } = args;
  await db.query(
    `UPDATE base_products SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [modifiedBy, baseProduct.id],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(baseProduct.id, baseProduct.image_url, null);
    await sweepReplacedImage(baseProduct.id, baseProduct.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point
 * the row in one `UPDATE`, then delete the old objects unless a gym Product
 * still shows them. Best-effort — a failed copy leaves the row on the old pair.
 */
export async function migrateBaseProductImageOnRename(
  baseProduct: BaseProductImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!baseProduct.image_url || !isStorageConfigured()) return null;
  if (!isBaseProductImageUrl(baseProduct.image_url)) return null;

  const oldKey = storageKeyFromObjectUrl(baseProduct.image_url);
  const newKey = buildBaseProductImageKey(baseProduct.id, baseProduct.name);
  const oldThumbKey = baseProduct.image_thumbnail_url && isBaseProductImageUrl(baseProduct.image_thumbnail_url)
    ? storageKeyFromObjectUrl(baseProduct.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildBaseProductImageThumbnailKey(baseProduct.id, baseProduct.name) : null;

  const moves: Array<[string, string]> = [];
  if (oldKey && oldKey !== newKey) moves.push([oldKey, newKey]);
  if (oldThumbKey && newThumbKey && oldThumbKey !== newThumbKey) moves.push([oldThumbKey, newThumbKey]);
  if (moves.length === 0) return null;

  const copied: string[] = [];
  for (const [from, to] of moves) {
    try {
      await copyStorageObject(from, to);
      copied.push(to);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'copyStorageObject', key: to });
      logger.warn({ err, details, baseProductId: baseProduct.id }, 'Renamed base product kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : baseProduct.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : baseProduct.image_thumbnail_url;
  await db.query(
    'UPDATE base_products SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND deleted_at IS NULL',
    [newUrl, newThumbUrl, baseProduct.id],
  );
  await sweepReplacedImage(baseProduct.id, baseProduct.image_url, newUrl);
  await sweepReplacedImage(baseProduct.id, baseProduct.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

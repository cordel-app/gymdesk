// The one place a Product's image is written to and cleared from
// Cloudflare R2 (#1715). The request parsing, the WebP processing, the upload
// limiter and the 409 for an uninitialized bucket are the Member photo's
// (`member-image-storage.ts`, #1449) and are imported, not copied; this module
// is the product-shaped store / clear / rename-move around them.

import { db } from '../infra/db';
import {
  buildProductImageKey,
  buildProductImageThumbnailKey,
  isGymOwnedProductImageUrl,
  productImageFolderKeys,
} from '../domain/productImages';
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
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';
import { pickImageVariant } from '../domain/productImages';
import { storageObjectUrlForms } from '../infra/storage';

/**
 * Whether any product other than `productId` still points at `key` (as master or
 * thumbnail, under any URL form). A copy inherits its source's URLs (#1715), so
 * an object may be shared: it is neither overwritten nor deleted while it is.
 */
export async function isProductImageKeyShared(gymId: string, productId: number | string, key: string | null): Promise<boolean> {
  if (!key) return false;
  const forms = storageObjectUrlForms(key);
  if (forms.length === 0) return false;
  const marks = forms.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT id FROM products WHERE id <> ? AND (image_url IN (${marks}) OR image_thumbnail_url IN (${marks})) LIMIT 1`,
    [productId, ...forms, ...forms],
  );
  return rows.length > 0;
}

export interface ProductImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const PRODUCT_IMAGE_COLUMNS = 'id, name, image_url, image_thumbnail_url';

/** Best-effort removal of an object the product stopped pointing at, after the row moved. */
async function sweepReplacedProductImage(
  gymId: string,
  folderPrefix: string | null,
  productId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isGymOwnedProductImageUrl(staleUrl, folderPrefix)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  if (await isProductImageKeyShared(gymId, productId, staleKey)) return;
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, productId }, 'Replaced product image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail under the product's keys, then points the row at
 * both in one `UPDATE`. A 502 refusal leaves the row on what it had before.
 */
export async function storeProductImage(args: {
  gymId: string;
  folderPrefix: string;
  product: ProductImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { gymId, folderPrefix, product, images, modifiedBy } = args;
  const plainKey = buildProductImageKey(folderPrefix, product.id, product.name);
  const plainThumbKey = buildProductImageThumbnailKey(folderPrefix, product.id, product.name);
  const shared = (await isProductImageKeyShared(gymId, product.id, plainKey))
    || (await isProductImageKeyShared(gymId, product.id, plainThumbKey));
  const variant = pickImageVariant(shared);
  const key = buildProductImageKey(folderPrefix, product.id, product.name, variant);
  const thumbnailKey = buildProductImageThumbnailKey(folderPrefix, product.id, product.name, variant);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(productImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, productId: product.id },
      'Cloudflare R2 product image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE products SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, thumbnailUrl, modifiedBy, product.id, gymId],
  );
  await sweepReplacedProductImage(gymId, folderPrefix, product.id, product.image_url, url);
  await sweepReplacedProductImage(gymId, folderPrefix, product.id, product.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the gym's own objects; others are left alone. */
export async function clearProductImage(args: {
  gymId: string;
  folderPrefix: string | null;
  product: ProductImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, folderPrefix, product, modifiedBy } = args;
  await db.query(
    `UPDATE products SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, product.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedProductImage(gymId, folderPrefix, product.id, product.image_url, null);
    await sweepReplacedProductImage(gymId, folderPrefix, product.id, product.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point
 * the row in one `UPDATE`, then delete the old objects. Best-effort — a failed
 * copy leaves the row on the old pair, which still renders. Answers the new
 * URLs, or null when nothing moved.
 */
export async function migrateProductImageOnRename(
  gymId: string,
  folderPrefix: string | null,
  product: ProductImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!product.image_url || !folderPrefix || !isStorageConfigured()) return null;
  if (!isGymOwnedProductImageUrl(product.image_url, folderPrefix)) return null;

  const oldKey = storageKeyFromObjectUrl(product.image_url);
  const newKey = buildProductImageKey(folderPrefix, product.id, product.name);
  const oldThumbKey = product.image_thumbnail_url && isGymOwnedProductImageUrl(product.image_thumbnail_url, folderPrefix)
    ? storageKeyFromObjectUrl(product.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildProductImageThumbnailKey(folderPrefix, product.id, product.name) : null;

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
      logger.warn({ err, details, productId: product.id }, 'Renamed product kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : product.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : product.image_thumbnail_url;
  await db.query(
    'UPDATE products SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?',
    [newUrl, newThumbUrl, product.id, gymId],
  );
  await sweepReplacedProductImage(gymId, folderPrefix, product.id, product.image_url, newUrl);
  await sweepReplacedProductImage(gymId, folderPrefix, product.id, product.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

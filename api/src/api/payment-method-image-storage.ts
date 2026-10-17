// The one place a Base Payment Method's image is written to and cleared from
// Cloudflare R2 (#1702). Request parsing, WebP processing and the upload limiter
// are the Member photo's (`member-image-storage.ts`) and are imported, not
// copied; this module is the method-shaped store / clear / rename-move around
// them, as `nutrition-goal-image-storage.ts` is for a goal. Platform-owned: one
// root (`cordel/payment_method/`), no gym, no 409 for an uninitialized bucket.

import { db } from '../infra/db';
import {
  buildPaymentMethodImageKey,
  buildPaymentMethodImageThumbnailKey,
  isOwnedPaymentMethodImageUrl,
  paymentMethodImageFolderKeys,
} from '../domain/paymentMethodImages';
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

export interface PaymentMethodImageRow {
  id: number;
  /** The name the key carries (see `paymentMethodImageName`). */
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

async function sweepReplacedImage(id: number, staleUrl: string | null, keepUrl: string | null): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isOwnedPaymentMethodImageUrl(staleUrl)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, paymentMethodId: id }, 'Replaced payment method image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail, then points the row at both in one `UPDATE`.
 * A 502 refusal leaves the row on what it had before; the old objects are only
 * swept after the new ones are stored.
 */
export async function storePaymentMethodImage(args: {
  method: PaymentMethodImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { method, images, modifiedBy } = args;
  const key = buildPaymentMethodImageKey(method.id, method.name);
  const thumbnailKey = buildPaymentMethodImageThumbnailKey(method.id, method.name);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(paymentMethodImageFolderKeys());
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), paymentMethodId: method.id },
      'Cloudflare R2 payment method image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE base_payment_methods SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [url, thumbnailUrl, modifiedBy, method.id],
  );
  await sweepReplacedImage(method.id, method.image_url, url);
  await sweepReplacedImage(method.id, method.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the platform's own objects. */
export async function clearPaymentMethodImage(args: {
  method: PaymentMethodImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { method, modifiedBy } = args;
  await db.query(
    `UPDATE base_payment_methods SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [modifiedBy, method.id],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(method.id, method.image_url, null);
    await sweepReplacedImage(method.id, method.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point
 * the row in one `UPDATE`, then delete the old ones. Best-effort — a failed copy
 * leaves the row on the old pair, which still renders.
 */
export async function migratePaymentMethodImageOnRename(
  method: PaymentMethodImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!method.image_url || !isStorageConfigured()) return null;
  if (!isOwnedPaymentMethodImageUrl(method.image_url)) return null;

  const oldKey = storageKeyFromObjectUrl(method.image_url);
  const newKey = buildPaymentMethodImageKey(method.id, method.name);
  const oldThumbKey = method.image_thumbnail_url && isOwnedPaymentMethodImageUrl(method.image_thumbnail_url)
    ? storageKeyFromObjectUrl(method.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildPaymentMethodImageThumbnailKey(method.id, method.name) : null;

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
      logger.warn({ err, details, paymentMethodId: method.id }, 'Renamed payment method kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : method.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : method.image_thumbnail_url;
  await db.query(
    'UPDATE base_payment_methods SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND deleted_at IS NULL',
    [newUrl, newThumbUrl, method.id],
  );
  await sweepReplacedImage(method.id, method.image_url, newUrl);
  await sweepReplacedImage(method.id, method.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

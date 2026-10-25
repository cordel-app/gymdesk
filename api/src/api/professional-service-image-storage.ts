// The one place a Professional Service's image is written to and cleared from
// Cloudflare R2 (#2010), for both roots: a gym's own service (`gymId` set, the
// gym's `storage_folder_prefix`) and a Base one (`gymId` null, `cordel`).
// Request parsing, WebP processing, the upload limiter and the 409 for an
// uninitialized bucket are the Member photo's (`member-image-storage.ts`) and are
// imported, not copied; this module is the service-shaped store / clear /
// rename-move around them, as `product-image-storage.ts` is for a Product.
//
// Like a Product, a Duplicate inherits the image *URLs* (one object, several
// rows), so a key another row still points at is neither overwritten (the upload
// takes a timestamped variant) nor deleted.

import { db } from '../infra/db';
import {
  buildProfessionalServiceImageKey,
  buildProfessionalServiceImageThumbnailKey,
  isOwnedProfessionalServiceImageUrl,
  professionalServiceImageFolderKeys,
} from '../domain/professionalServiceImages';
import { pickImageVariant } from '../domain/productImages';
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

export interface ProfessionalServiceImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const PROFESSIONAL_SERVICE_IMAGE_COLUMNS = 'id, name, image_url, image_thumbnail_url';

/** Where the service lives: a gym's own (`gymId`) or the platform's (`null`), and the key prefix of its folder. */
export interface ProfessionalServiceImageScope {
  gymId: string | null;
  prefix: string | null;
}

/** The ownership predicate of the row, so a gym write can never touch a Base service or another gym's. */
function ownerWhere(scope: ProfessionalServiceImageScope): { sql: string; params: unknown[] } {
  return scope.gymId === null
    ? { sql: 'gym_id IS NULL', params: [] }
    : { sql: 'gym_id = ?', params: [scope.gymId] };
}

/**
 * Whether any service other than `serviceId` still points at `key` (as master or
 * thumbnail, under any URL form). A Duplicate inherits its source's URLs, so an
 * object may be shared: it is neither overwritten nor deleted while it is.
 */
export async function isProfessionalServiceImageKeyShared(serviceId: number | string, key: string | null): Promise<boolean> {
  if (!key) return false;
  const forms = storageObjectUrlForms(key);
  if (forms.length === 0) return false;
  const marks = forms.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT id FROM professional_services WHERE id <> ? AND (image_url IN (${marks}) OR image_thumbnail_url IN (${marks})) LIMIT 1`,
    [serviceId, ...forms, ...forms],
  );
  return rows.length > 0;
}

/** Best-effort removal of an object the service stopped pointing at, after the row moved. */
async function sweepReplacedImage(
  scope: ProfessionalServiceImageScope,
  serviceId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isOwnedProfessionalServiceImageUrl(staleUrl, scope.prefix)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  if (await isProfessionalServiceImageKeyShared(serviceId, staleKey)) return;
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, serviceId }, 'Replaced professional service image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail under the service's keys, then points the row at
 * both in one `UPDATE`. A 502 refusal leaves the row on what it had before.
 */
export async function storeProfessionalServiceImage(args: {
  scope: ProfessionalServiceImageScope & { prefix: string };
  service: ProfessionalServiceImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { scope, service, images, modifiedBy } = args;
  const plainKey = buildProfessionalServiceImageKey(scope.prefix, service.id, service.name);
  const plainThumbKey = buildProfessionalServiceImageThumbnailKey(scope.prefix, service.id, service.name);
  const shared = (await isProfessionalServiceImageKeyShared(service.id, plainKey))
    || (await isProfessionalServiceImageKeyShared(service.id, plainThumbKey));
  const variant = pickImageVariant(shared);
  const key = buildProfessionalServiceImageKey(scope.prefix, service.id, service.name, variant);
  const thumbnailKey = buildProfessionalServiceImageThumbnailKey(scope.prefix, service.id, service.name, variant);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(professionalServiceImageFolderKeys(scope.prefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId: scope.gymId, serviceId: service.id },
      'Cloudflare R2 professional service image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  const owner = ownerWhere(scope);
  await db.query(
    `UPDATE professional_services SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND ${owner.sql}`,
    [url, thumbnailUrl, modifiedBy, service.id, ...owner.params],
  );
  await sweepReplacedImage(scope, service.id, service.image_url, url);
  await sweepReplacedImage(scope, service.id, service.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the scope's own objects; others are left alone. */
export async function clearProfessionalServiceImage(args: {
  scope: ProfessionalServiceImageScope;
  service: ProfessionalServiceImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { scope, service, modifiedBy } = args;
  const owner = ownerWhere(scope);
  await db.query(
    `UPDATE professional_services SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND ${owner.sql}`,
    [modifiedBy, service.id, ...owner.params],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(scope, service.id, service.image_url, null);
    await sweepReplacedImage(scope, service.id, service.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point
 * the row in one `UPDATE`, then delete the old objects. Best-effort — a failed
 * copy leaves the row on the old pair, which still renders. An object another
 * row shares is copied, never moved, so its other owners keep rendering.
 */
export async function migrateProfessionalServiceImageOnRename(
  scope: ProfessionalServiceImageScope,
  service: ProfessionalServiceImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  const prefix = scope.prefix;
  if (!service.image_url || !prefix || !isStorageConfigured()) return null;
  if (!isOwnedProfessionalServiceImageUrl(service.image_url, prefix)) return null;

  const oldKey = storageKeyFromObjectUrl(service.image_url);
  const newKey = buildProfessionalServiceImageKey(prefix, service.id, service.name);
  const oldThumbKey = service.image_thumbnail_url && isOwnedProfessionalServiceImageUrl(service.image_thumbnail_url, prefix)
    ? storageKeyFromObjectUrl(service.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildProfessionalServiceImageThumbnailKey(prefix, service.id, service.name) : null;

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
      logger.warn({ err, details, serviceId: service.id }, 'Renamed professional service kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : service.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : service.image_thumbnail_url;
  const owner = ownerWhere(scope);
  await db.query(
    `UPDATE professional_services SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND ${owner.sql}`,
    [newUrl, newThumbUrl, service.id, ...owner.params],
  );
  await sweepReplacedImage(scope, service.id, service.image_url, newUrl);
  await sweepReplacedImage(scope, service.id, service.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

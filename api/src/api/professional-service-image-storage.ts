// The one place a Professional Service's image is written to and cleared from
// Cloudflare R2 (#2010), for both roots: a gym's own service (`gymId` set, the
// gym's `storage_folder_prefix`) and a Base one (`gymId` null, `cordel`).
// Request parsing, WebP processing, the upload limiter and the 409 for an
// uninitialized bucket are the Member photo's (`member-image-storage.ts`) and are
// imported, not copied; this module is the service-shaped store / clear /
// rename-move around them, as `product-image-storage.ts` is for a Product.
//
// Since #3350 stage 3 the key carries the service's persisted slug, not its
// name, so a rename never moves the image (there is no rename move any more).
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
import { imageKeyIdentifier } from '../domain/imageKeySlug';

export interface ProfessionalServiceImageRow {
  id: number;
  name: string;
  /** The service's persisted slug (#3350); read from the row when the caller has not. */
  slug?: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const PROFESSIONAL_SERVICE_IMAGE_COLUMNS = 'id, name, slug, image_url, image_thumbnail_url';

/**
 * What a service's image keys carry (#3350): its persisted slug, never its name,
 * so a rename never moves the image. Read from the row when the caller did not
 * pass it.
 */
async function serviceKeyIdentifier(service: { id: number; name: string; slug?: string | null }): Promise<string> {
  if (service.slug !== undefined) return imageKeyIdentifier(service);
  const { rows } = await db.query<{ slug: string | null }>('SELECT slug FROM professional_services WHERE id = ?', [service.id]);
  return imageKeyIdentifier({ name: service.name, slug: rows[0]?.slug ?? null });
}

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
  const keyId = await serviceKeyIdentifier(service);
  const plainKey = buildProfessionalServiceImageKey(scope.prefix, service.id, keyId);
  const plainThumbKey = buildProfessionalServiceImageThumbnailKey(scope.prefix, service.id, keyId);
  const shared = (await isProfessionalServiceImageKeyShared(service.id, plainKey))
    || (await isProfessionalServiceImageKeyShared(service.id, plainThumbKey));
  const variant = pickImageVariant(shared);
  const key = buildProfessionalServiceImageKey(scope.prefix, service.id, keyId, variant);
  const thumbnailKey = buildProfessionalServiceImageThumbnailKey(scope.prefix, service.id, keyId, variant);
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
 * Import (#2010 stage 2): copies a Base service's master and thumbnail into the
 * gym's own folder under the *new* service's id, server-side, and points the
 * gym's row at the copies. The copy is independent of the Base objects. A failed
 * copy deletes what it wrote and leaves the row without an image — never a row
 * pointing at a missing object. A Base service with no image, an unconfigured
 * bucket or a gym with no folder prefix imports without one. Returns whether
 * the image was copied.
 */
export async function copyBaseProfessionalServiceImage(args: {
  gymId: string;
  prefix: string | null;
  base: { image_url: string | null; image_thumbnail_url: string | null };
  service: { id: number; name: string; slug?: string | null };
}): Promise<boolean> {
  const { gymId, prefix, base, service } = args;
  if (!base.image_url || !prefix || !isStorageConfigured()) return false;
  const sourceKey = storageKeyFromObjectUrl(base.image_url);
  if (!sourceKey) return false;
  const sourceThumbKey = base.image_thumbnail_url ? storageKeyFromObjectUrl(base.image_thumbnail_url) : null;

  const keyId = await serviceKeyIdentifier(service);
  const destKey = buildProfessionalServiceImageKey(prefix, service.id, keyId);
  const destThumbKey = buildProfessionalServiceImageThumbnailKey(prefix, service.id, keyId);
  const written: string[] = [];
  try {
    await ensureStorageFolders(professionalServiceImageFolderKeys(prefix));
    await copyStorageObject(sourceKey, destKey);
    written.push(destKey);
    if (sourceThumbKey) {
      await copyStorageObject(sourceThumbKey, destThumbKey);
      written.push(destThumbKey);
    }
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'copyStorageObject', key: destKey });
    logger.warn({ err, details, gymId, serviceId: service.id }, 'Imported professional service has no image: copy from the Base service failed');
    for (const key of written) {
      try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
    }
    return false;
  }

  await db.query(
    `UPDATE professional_services SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?`,
    [
      buildStorageObjectUrl(destKey) as string,
      sourceThumbKey ? (buildStorageObjectUrl(destThumbKey) as string) : null,
      service.id,
      gymId,
    ],
  );
  return true;
}

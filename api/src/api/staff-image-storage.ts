// The one place a Staff's image is written to and cleared from Cloudflare R2
// (#2262). Request parsing, WebP processing, the upload limiter and the 409 for
// an uninitialized bucket are the Member photo's (`member-image-storage.ts`) and
// are imported, not copied. Staff duplication copies no image, so an object is never
// shared between rows and no variant keys are needed.

import { db } from '../infra/db';
import {
  buildStaffImageKey,
  buildStaffImageThumbnailKey,
  staffImageFolderKeys,
  isOwnedStaffImageUrl,
} from '../domain/staffImages';
import { staffImageName } from '../domain/staffImages';
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

export interface StaffImageRow {
  id: number;
  first_name: string;
  last_name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const STAFF_IMAGE_COLUMNS = 'id, first_name, last_name, image_url, image_thumbnail_url';

/** Best-effort removal of an object the Staff stopped pointing at, after the row moved. */
async function sweepReplacedImage(
  prefix: string | null, staffId: number | string, staleUrl: string | null, keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isOwnedStaffImageUrl(staleUrl, prefix)) return;
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
    logger.warn({ err, details, staffId }, 'Replaced staff image left an orphaned object in Cloudflare R2');
  }
}

/** Uploads master and thumbnail, then points the row at both in one `UPDATE`. */
export async function storeStaffImage(args: {
  gymId: string;
  prefix: string;
  staff: StaffImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { gymId, prefix, staff, images, modifiedBy } = args;
  const key = buildStaffImageKey(prefix, staff.id, staffImageName(staff));
  const thumbnailKey = buildStaffImageThumbnailKey(prefix, staff.id, staffImageName(staff));
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(staffImageFolderKeys(prefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, staffId: staff.id },
      'Cloudflare R2 staff image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE staff SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, thumbnailUrl, modifiedBy, staff.id, gymId],
  );
  await sweepReplacedImage(prefix, staff.id, staff.image_url, url);
  await sweepReplacedImage(prefix, staff.id, staff.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the gym's own objects; others are left alone. */
export async function clearStaffImage(args: {
  gymId: string;
  prefix: string | null;
  staff: StaffImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, prefix, staff, modifiedBy } = args;
  await db.query(
    `UPDATE staff SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, staff.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(prefix, staff.id, staff.image_url, null);
    await sweepReplacedImage(prefix, staff.id, staff.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point the
 * row in one `UPDATE`, then delete the old objects. Best-effort — a failed copy
 * leaves the row on the old pair, which still renders.
 */
export async function migrateStaffImageOnRename(
  gymId: string, prefix: string | null, staff: StaffImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!staff.image_url || !prefix || !isStorageConfigured()) return null;
  if (!isOwnedStaffImageUrl(staff.image_url, prefix)) return null;

  const oldKey = storageKeyFromObjectUrl(staff.image_url);
  const newKey = buildStaffImageKey(prefix, staff.id, staffImageName(staff));
  const oldThumbKey = staff.image_thumbnail_url && isOwnedStaffImageUrl(staff.image_thumbnail_url, prefix)
    ? storageKeyFromObjectUrl(staff.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildStaffImageThumbnailKey(prefix, staff.id, staffImageName(staff)) : null;

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
      logger.warn({ err, details, staffId: staff.id }, 'Renamed staff kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : staff.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : staff.image_thumbnail_url;
  await db.query(
    `UPDATE staff SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?`,
    [newUrl, newThumbUrl, staff.id, gymId],
  );
  await sweepReplacedImage(prefix, staff.id, staff.image_url, newUrl);
  await sweepReplacedImage(prefix, staff.id, staff.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

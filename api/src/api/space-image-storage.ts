// The one place a Space's image is written to and cleared from Cloudflare R2
// (#2260). Request parsing, WebP processing, the upload limiter and the 409 for
// an uninitialized bucket are the Member photo's (`member-image-storage.ts`) and
// are imported, not copied. A Space is never duplicated, so an object is never
// shared between rows and no variant keys are needed.

import { db } from '../infra/db';
import {
  buildSpaceImageKey,
  buildSpaceImageThumbnailKey,
  spaceImageFolderKeys,
  isOwnedSpaceImageUrl,
} from '../domain/spaceImages';
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

export interface SpaceImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const SPACE_IMAGE_COLUMNS = 'id, name, image_url, image_thumbnail_url';

/** Best-effort removal of an object the Space stopped pointing at, after the row moved. */
async function sweepReplacedImage(
  prefix: string | null, spaceId: number | string, staleUrl: string | null, keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isOwnedSpaceImageUrl(staleUrl, prefix)) return;
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
    logger.warn({ err, details, spaceId }, 'Replaced space image left an orphaned object in Cloudflare R2');
  }
}

/** Uploads master and thumbnail, then points the row at both in one `UPDATE`. */
export async function storeSpaceImage(args: {
  gymId: string;
  prefix: string;
  space: SpaceImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { gymId, prefix, space, images, modifiedBy } = args;
  const key = buildSpaceImageKey(prefix, space.id, space.name);
  const thumbnailKey = buildSpaceImageThumbnailKey(prefix, space.id, space.name);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(spaceImageFolderKeys(prefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, spaceId: space.id },
      'Cloudflare R2 space image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE spaces SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, thumbnailUrl, modifiedBy, space.id, gymId],
  );
  await sweepReplacedImage(prefix, space.id, space.image_url, url);
  await sweepReplacedImage(prefix, space.id, space.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the gym's own objects; others are left alone. */
export async function clearSpaceImage(args: {
  gymId: string;
  prefix: string | null;
  space: SpaceImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, prefix, space, modifiedBy } = args;
  await db.query(
    `UPDATE spaces SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, space.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(prefix, space.id, space.image_url, null);
    await sweepReplacedImage(prefix, space.id, space.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point the
 * row in one `UPDATE`, then delete the old objects. Best-effort — a failed copy
 * leaves the row on the old pair, which still renders.
 */
export async function migrateSpaceImageOnRename(
  gymId: string, prefix: string | null, space: SpaceImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!space.image_url || !prefix || !isStorageConfigured()) return null;
  if (!isOwnedSpaceImageUrl(space.image_url, prefix)) return null;

  const oldKey = storageKeyFromObjectUrl(space.image_url);
  const newKey = buildSpaceImageKey(prefix, space.id, space.name);
  const oldThumbKey = space.image_thumbnail_url && isOwnedSpaceImageUrl(space.image_thumbnail_url, prefix)
    ? storageKeyFromObjectUrl(space.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildSpaceImageThumbnailKey(prefix, space.id, space.name) : null;

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
      logger.warn({ err, details, spaceId: space.id }, 'Renamed space kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : space.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : space.image_thumbnail_url;
  await db.query(
    `UPDATE spaces SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?`,
    [newUrl, newThumbUrl, space.id, gymId],
  );
  await sweepReplacedImage(prefix, space.id, space.image_url, newUrl);
  await sweepReplacedImage(prefix, space.id, space.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

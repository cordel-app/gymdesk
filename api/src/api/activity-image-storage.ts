// The one place an Activity Type's image is written to and cleared from
// Cloudflare R2 (#1373). `member-image-storage.ts`'s arrangement one table over:
// upload first, point the row at it second, sweep the previous object last — so a
// failure at any step leaves the activity pointing at an object that exists.

import { db } from '../infra/db';
import {
  activityImageFolderKeys,
  activityImageThumbnailUrl,
  buildActivityImageKey,
  buildActivityImageThumbnailKey,
  isGymOwnedActivityImageUrl,
} from '../domain/activityImages';
import { MEMBER_IMAGE_STORED_MIME } from '../domain/memberImages';
import type { ProcessedMemberImage } from '../domain/memberImageProcessing';
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
import {
  gymStorageFolderPrefix,
  isMemberImageRefusal,
  memberImageBodyParser,
  memberImageUploadRateLimit,
  parseMemberImageRequest,
  type MemberImageRefusal,
} from './member-image-storage';

export { gymStorageFolderPrefix };

export interface ActivityImageRow {
  id: number;
  name: string;
  image_url: string | null;
}

export type ActivityImageRefusal = MemberImageRefusal;
export const isActivityImageRefusal = isMemberImageRefusal;

/** #1714: the Member photo's upload plumbing — one limiter, one raw-body parser, one processor. */
export const activityImageUploadRateLimit = memberImageUploadRateLimit;
export const activityImageBodyParser = memberImageBodyParser;
export const parseActivityImageRequest = parseMemberImageRequest;

export const ACTIVITY_STORAGE_NOT_INITIALIZED: ActivityImageRefusal = {
  status: 409,
  body: { error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.' },
};

/** Best-effort removal of an object the activity stopped pointing at, always after the row moved. */
export async function sweepReplacedActivityImage(
  folderPrefix: string | null,
  activityId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isGymOwnedActivityImageUrl(staleUrl, folderPrefix)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  const keys = [staleKey];
  const staleThumb = activityImageThumbnailUrl(staleUrl);
  const staleThumbKey = staleThumb ? storageKeyFromObjectUrl(staleThumb) : null;
  const keepThumb = activityImageThumbnailUrl(keepUrl);
  const keepThumbKey = keepThumb ? storageKeyFromObjectUrl(keepThumb) : null;
  if (staleThumbKey && staleThumbKey !== keepThumbKey) keys.push(staleThumbKey);
  for (const key of keys) {
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.warn({ err, details, activityId }, 'Replaced activity image left an orphaned object in Cloudflare R2');
    }
  }
}

/** Uploads under the activity's own key, then points the row at it, then sweeps. */
export async function storeActivityImage(args: {
  gymId: string;
  folderPrefix: string;
  activity: ActivityImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<string | ActivityImageRefusal> {
  const { gymId, folderPrefix, activity, images, modifiedBy } = args;
  const key = buildActivityImageKey(folderPrefix, activity.id, activity.name);
  const thumbnailKey = buildActivityImageThumbnailKey(folderPrefix, activity.id, activity.name);
  const url = buildStorageObjectUrl(key) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(activityImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, activityId: activity.id },
      'Cloudflare R2 activity image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE activity_types SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, modifiedBy, activity.id, gymId],
  );
  await sweepReplacedActivityImage(folderPrefix, activity.id, activity.image_url, url);
  return url;
}

/** Clears the reference and deletes the gym's own object; no bucket is needed to clear a reference. */
export async function clearActivityImage(args: {
  gymId: string;
  folderPrefix: string | null;
  activity: ActivityImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, folderPrefix, activity, modifiedBy } = args;
  await db.query(
    `UPDATE activity_types SET image_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, activity.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedActivityImage(folderPrefix, activity.id, activity.image_url, null);
  }
}

/**
 * After a rename: copy to the new key, point the row at it, only then delete the
 * old object. Best-effort and logged; a failed copy leaves the old URL, which
 * still renders. Answers the new URL or null when nothing moved.
 */
export async function migrateActivityImageOnRename(
  gymId: string,
  activity: ActivityImageRow,
  modifiedBy: string | null = null,
): Promise<string | null> {
  if (!activity.image_url || !isStorageConfigured()) return null;
  const folderPrefix = await gymStorageFolderPrefix(gymId);
  if (!folderPrefix || !isGymOwnedActivityImageUrl(activity.image_url, folderPrefix)) return null;
  const oldKey = storageKeyFromObjectUrl(activity.image_url);
  const newKey = buildActivityImageKey(folderPrefix, activity.id, activity.name);
  if (!oldKey || oldKey === newKey) return null;
  // A pre-#1714 PNG keeps its key: copying PNG bytes to a `.webp` key would lie about the format.
  if (!oldKey.endsWith('.webp')) return null;
  const newUrl = buildStorageObjectUrl(newKey) as string;
  const oldThumbUrl = activityImageThumbnailUrl(activity.image_url);
  const oldThumbKey = oldThumbUrl ? storageKeyFromObjectUrl(oldThumbUrl) : null;
  const newThumbKey = oldThumbKey ? buildActivityImageThumbnailKey(folderPrefix, activity.id, activity.name) : null;
  try {
    await copyStorageObject(oldKey, newKey);
    if (oldThumbKey && newThumbKey) {
      try { await copyStorageObject(oldThumbKey, newThumbKey); } catch { /* thumbnail is optional: the master still renders */ }
    }
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'copyStorageObject', key: newKey });
    logger.warn({ err, details, activityId: activity.id }, 'Renamed activity kept its image on the previous key: copy failed');
    return null;
  }
  await db.query(
    'UPDATE activity_types SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?',
    [newUrl, modifiedBy, activity.id, gymId],
  );
  await sweepReplacedActivityImage(folderPrefix, activity.id, activity.image_url, newUrl);
  return newUrl;
}

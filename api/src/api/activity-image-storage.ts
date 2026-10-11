// The one place an Activity Type's image is written to and cleared from
// Cloudflare R2 (#1373). `member-image-storage.ts`'s arrangement one table over:
// upload first, point the row at it second, sweep the previous object last — so a
// failure at any step leaves the activity pointing at an object that exists.

import express from 'express';
import { db } from '../infra/db';
import {
  ACTIVITY_IMAGE_MAX_BYTES,
  ACTIVITY_IMAGE_MIME,
  ACTIVITY_IMAGE_REJECTION_MESSAGES,
  activityImageFolderKeys,
  buildActivityImageKey,
  isGymOwnedActivityImageUrl,
  validateActivityImage,
} from '../domain/activityImages';
import {
  buildStorageObjectUrl,
  copyStorageObject,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';
import { gymStorageFolderPrefix } from './member-image-storage';

export { gymStorageFolderPrefix };

export interface ActivityImageRow {
  id: number;
  name: string;
  image_url: string | null;
}

export interface ActivityImageRefusal {
  status: number;
  body: Record<string, unknown>;
}

export function isActivityImageRefusal(value: unknown): value is ActivityImageRefusal {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

export const activityImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: ACTIVITY_IMAGE_MAX_BYTES + 64 * 1024,
});

/** The bytes an upload carries, or the refusal saying why there are none. */
export function parseActivityImageRequest(req: express.Request): Buffer | ActivityImageRefusal {
  const mime = req.headers['content-type']?.split(';')[0]?.trim();
  if (mime !== ACTIVITY_IMAGE_MIME) {
    return { status: 415, body: { error: `Unsupported image type. Allowed: ${ACTIVITY_IMAGE_MIME}` } };
  }
  const raw: unknown = req.body;
  if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
    return { status: 400, body: { error: 'Request body must be raw image bytes' } };
  }
  const body: Buffer = raw;
  if (body.length === 0) return { status: 400, body: { error: 'Request body is empty' } };
  if (body.length > ACTIVITY_IMAGE_MAX_BYTES) {
    return { status: 413, body: { error: `Image exceeds ${ACTIVITY_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` } };
  }
  const rejection = validateActivityImage(body);
  if (rejection) {
    return { status: 400, body: { error: ACTIVITY_IMAGE_REJECTION_MESSAGES[rejection], reason: rejection } };
  }
  if (!isStorageConfigured()) {
    const missingConfig = getMissingStorageConfigKeys();
    return {
      status: 503,
      body: {
        error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
        missingConfig,
      },
    };
  }
  return body;
}

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
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, activityId }, 'Replaced activity image left an orphaned object in Cloudflare R2');
  }
}

/** Uploads under the activity's own key, then points the row at it, then sweeps. */
export async function storeActivityImage(args: {
  gymId: string;
  folderPrefix: string;
  activity: ActivityImageRow;
  body: Buffer;
  modifiedBy: number | null;
}): Promise<string | ActivityImageRefusal> {
  const { gymId, folderPrefix, activity, body, modifiedBy } = args;
  const key = buildActivityImageKey(folderPrefix, activity.id, activity.name);
  const url = buildStorageObjectUrl(key) as string;

  try {
    await ensureStorageFolders(activityImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, ACTIVITY_IMAGE_MIME, body);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, activityId: activity.id },
      'Cloudflare R2 activity image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE activity_types SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
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
  modifiedBy: number | null;
}): Promise<void> {
  const { gymId, folderPrefix, activity, modifiedBy } = args;
  await db.query(
    `UPDATE activity_types SET image_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
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
): Promise<string | null> {
  if (!activity.image_url || !isStorageConfigured()) return null;
  const folderPrefix = await gymStorageFolderPrefix(gymId);
  if (!folderPrefix || !isGymOwnedActivityImageUrl(activity.image_url, folderPrefix)) return null;
  const oldKey = storageKeyFromObjectUrl(activity.image_url);
  const newKey = buildActivityImageKey(folderPrefix, activity.id, activity.name);
  if (!oldKey || oldKey === newKey) return null;
  const newUrl = buildStorageObjectUrl(newKey) as string;
  try {
    await copyStorageObject(oldKey, newKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'copyStorageObject', key: newKey });
    logger.warn({ err, details, activityId: activity.id }, 'Renamed activity kept its image on the previous key: copy failed');
    return null;
  }
  await db.query('UPDATE activity_types SET image_url = ? WHERE id = ? AND gym_id = ?', [newUrl, activity.id, gymId]);
  await sweepReplacedActivityImage(folderPrefix, activity.id, activity.image_url, newUrl);
  return newUrl;
}

// The one place a Calendar Event's own image is written to and cleared from
// Cloudflare R2 (#1382, #1765). `activity-image-storage.ts`'s arrangement one
// table over (upload both objects first, point the row at them second, sweep the
// previous objects last), and it reuses that file's request parsing and refusals
// rather than restating them. It never touches `activity_types.image_url` nor
// another event's object: the key is the event's own, and a sweep deletes only
// an object under the gym's own `calendar_events/` folder (or a pre-#1765
// `activities/event-` one).

import { db } from '../infra/db';
import {
  buildEventImageKey,
  buildEventImageThumbnailKey,
  eventImageFolderKeys,
  isGymOwnedEventImageUrl,
} from '../domain/calendarEventImages';
import { activityImageThumbnailUrl } from '../domain/activityImages';
import { MEMBER_IMAGE_STORED_MIME } from '../domain/memberImages';
import type { ProcessedMemberImage } from '../domain/memberImageProcessing';
import {
  buildStorageObjectUrl,
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
import type { ActivityImageRefusal } from './activity-image-storage';

export interface EventImageRow {
  id: number;
  /** The key's name: the event's title, else its Activity's name. */
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

async function sweepReplacedEventImage(
  folderPrefix: string | null,
  eventId: number | string,
  staleUrl: string | null,
  staleThumbnailUrl: string | null,
  keepUrl: string | null,
  keepThumbnailUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isGymOwnedEventImageUrl(staleUrl, folderPrefix)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
  if (keepKey && staleKey === keepKey) return;
  const keys = [staleKey];
  const staleThumb = staleThumbnailUrl ?? activityImageThumbnailUrl(staleUrl);
  const staleThumbKey = staleThumb ? storageKeyFromObjectUrl(staleThumb) : null;
  const keepThumb = keepThumbnailUrl ?? activityImageThumbnailUrl(keepUrl);
  const keepThumbKey = keepThumb ? storageKeyFromObjectUrl(keepThumb) : null;
  if (staleThumbKey && staleThumbKey !== keepThumbKey) keys.push(staleThumbKey);
  for (const key of keys) {
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.warn({ err, details, eventId }, 'Replaced event image left an orphaned object in Cloudflare R2');
    }
  }
}

/** Uploads under the event's own key, then points the row at it, then sweeps. A failed upload leaves the row untouched. */
export async function storeEventImage(args: {
  gymId: string;
  folderPrefix: string;
  event: EventImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<string | ActivityImageRefusal> {
  const { gymId, folderPrefix, event, images, modifiedBy } = args;
  const key = buildEventImageKey(folderPrefix, event.id, event.name);
  const thumbnailKey = buildEventImageThumbnailKey(folderPrefix, event.id, event.name);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(eventImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, eventId: event.id },
      'Cloudflare R2 event image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE calendar_events SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, thumbnailUrl, modifiedBy, event.id, gymId],
  );
  await sweepReplacedEventImage(folderPrefix, event.id, event.image_url, event.image_thumbnail_url, url, thumbnailUrl);
  return url;
}

/** Clears the override (the event falls back to its Activity's image) and deletes the gym's own object. */
export async function clearEventImage(args: {
  gymId: string;
  folderPrefix: string | null;
  event: EventImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, folderPrefix, event, modifiedBy } = args;
  await db.query(
    `UPDATE calendar_events SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, event.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedEventImage(folderPrefix, event.id, event.image_url, event.image_thumbnail_url, null, null);
  }
}

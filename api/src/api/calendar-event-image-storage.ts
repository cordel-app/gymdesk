// The one place a Calendar Event's own image is written to and cleared from
// Cloudflare R2 (#1382). `activity-image-storage.ts`'s arrangement one table
// over (upload first, point the row at it second, sweep the previous object
// last), and it reuses that file's request parsing and refusals rather than
// restating them. It never touches `activity_types.image_url` nor another
// event's object: the key is the event's own, and a sweep deletes only an
// `event-` object under the gym's own `activities/` folder.

import { db } from '../infra/db';
import {
  EVENT_IMAGE_MIME,
  buildEventImageKey,
  eventImageFolderKeys,
  isGymOwnedEventImageUrl,
} from '../domain/calendarEventImages';
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
  activity_name: string;
  image_url: string | null;
}

async function sweepReplacedEventImage(
  folderPrefix: string | null,
  eventId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isGymOwnedEventImageUrl(staleUrl, folderPrefix)) return;
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
    logger.warn({ err, details, eventId }, 'Replaced event image left an orphaned object in Cloudflare R2');
  }
}

/** Uploads under the event's own key, then points the row at it, then sweeps. A failed upload leaves the row untouched. */
export async function storeEventImage(args: {
  gymId: string;
  folderPrefix: string;
  event: EventImageRow;
  body: Buffer;
  modifiedBy: string | null;
}): Promise<string | ActivityImageRefusal> {
  const { gymId, folderPrefix, event, body, modifiedBy } = args;
  const key = buildEventImageKey(folderPrefix, event.id, event.activity_name);
  const url = buildStorageObjectUrl(key) as string;

  try {
    await ensureStorageFolders(eventImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, EVENT_IMAGE_MIME, body);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, eventId: event.id },
      'Cloudflare R2 event image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE calendar_events SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, modifiedBy, event.id, gymId],
  );
  await sweepReplacedEventImage(folderPrefix, event.id, event.image_url, url);
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
    `UPDATE calendar_events SET image_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, event.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedEventImage(folderPrefix, event.id, event.image_url, null);
  }
}

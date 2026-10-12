// The one place a Membership Plan's image is written to and cleared from
// Cloudflare R2 (#1514). The request parsing, the WebP processing, the upload
// limiter and the 409 for an uninitialized bucket are the Member photo's
// (`member-image-storage.ts`, #1449) and are imported, not copied; this module
// is the plan-shaped store / clear / rename-move around them.

import { db } from '../infra/db';
import {
  buildPlanImageKey,
  buildPlanImageThumbnailKey,
  isGymOwnedPlanImageUrl,
  planImageFolderKeys,
} from '../domain/planImages';
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

export interface PlanImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export const PLAN_IMAGE_COLUMNS = 'id, name, image_url, image_thumbnail_url';

/** Best-effort removal of an object the plan stopped pointing at, after the row moved. */
async function sweepReplacedPlanImage(
  folderPrefix: string | null,
  planId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isGymOwnedPlanImageUrl(staleUrl, folderPrefix)) return;
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
    logger.warn({ err, details, planId }, 'Replaced plan image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail under the plan's keys, then points the row at
 * both in one `UPDATE`. A 502 refusal leaves the row on what it had before.
 */
export async function storePlanImage(args: {
  gymId: string;
  folderPrefix: string;
  plan: PlanImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { gymId, folderPrefix, plan, images, modifiedBy } = args;
  const key = buildPlanImageKey(folderPrefix, plan.id, plan.name);
  const thumbnailKey = buildPlanImageThumbnailKey(folderPrefix, plan.id, plan.name);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(planImageFolderKeys(folderPrefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId, planId: plan.id },
      'Cloudflare R2 plan image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE membership_plans SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [url, thumbnailUrl, modifiedBy, plan.id, gymId],
  );
  await sweepReplacedPlanImage(folderPrefix, plan.id, plan.image_url, url);
  await sweepReplacedPlanImage(folderPrefix, plan.id, plan.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the gym's own objects; others are left alone. */
export async function clearPlanImage(args: {
  gymId: string;
  folderPrefix: string | null;
  plan: PlanImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { gymId, folderPrefix, plan, modifiedBy } = args;
  await db.query(
    `UPDATE membership_plans SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND gym_id = ?`,
    [modifiedBy, plan.id, gymId],
  );
  if (isStorageConfigured()) {
    await sweepReplacedPlanImage(folderPrefix, plan.id, plan.image_url, null);
    await sweepReplacedPlanImage(folderPrefix, plan.id, plan.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point
 * the row in one `UPDATE`, then delete the old objects. Best-effort — a failed
 * copy leaves the row on the old pair, which still renders. Answers the new
 * URLs, or null when nothing moved.
 */
export async function migratePlanImageOnRename(
  gymId: string,
  folderPrefix: string | null,
  plan: PlanImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  if (!plan.image_url || !folderPrefix || !isStorageConfigured()) return null;
  if (!isGymOwnedPlanImageUrl(plan.image_url, folderPrefix)) return null;

  const oldKey = storageKeyFromObjectUrl(plan.image_url);
  const newKey = buildPlanImageKey(folderPrefix, plan.id, plan.name);
  const oldThumbKey = plan.image_thumbnail_url && isGymOwnedPlanImageUrl(plan.image_thumbnail_url, folderPrefix)
    ? storageKeyFromObjectUrl(plan.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildPlanImageThumbnailKey(folderPrefix, plan.id, plan.name) : null;

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
      logger.warn({ err, details, planId: plan.id }, 'Renamed plan kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : plan.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : plan.image_thumbnail_url;
  await db.query(
    'UPDATE membership_plans SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?',
    [newUrl, newThumbUrl, plan.id, gymId],
  );
  await sweepReplacedPlanImage(folderPrefix, plan.id, plan.image_url, newUrl);
  await sweepReplacedPlanImage(folderPrefix, plan.id, plan.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

// The one place a Nutrition Goal's image is written to and cleared from
// Cloudflare R2 (#1623), for both roots: a gym's own goal (`gymId` set, the
// gym's `storage_folder_prefix`) and a System goal (`gymId` null, `cordel`).
// Request parsing, WebP processing, the upload limiter and the 409 for an
// uninitialized bucket are the Member photo's (`member-image-storage.ts`) and are
// imported, not copied; this module is the goal-shaped store / clear / rename-move
// around them, as `plan-image-storage.ts` is for a Membership Plan.

import { db } from '../infra/db';
import {
  buildNutritionGoalImageKey,
  buildNutritionGoalImageThumbnailKey,
  isOwnedNutritionGoalImageUrl,
  nutritionGoalImageFolderKeys,
} from '../domain/nutritionGoalImages';
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

export interface NutritionGoalImageRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

/** Where the goal lives: a gym's own (`gymId`) or the platform's (`null`), and the key prefix of its folder. */
export interface NutritionGoalImageScope {
  gymId: string | null;
  prefix: string | null;
}

/** The ownership predicate of the row, so a gym write can never touch a System goal or another gym's. */
function ownerWhere(scope: NutritionGoalImageScope): { sql: string; params: unknown[] } {
  return scope.gymId === null
    ? { sql: 'gym_id IS NULL', params: [] }
    : { sql: 'gym_id = ?', params: [scope.gymId] };
}

/** Best-effort removal of an object the goal stopped pointing at, after the row moved. */
async function sweepReplacedImage(
  scope: NutritionGoalImageScope,
  goalId: number | string,
  staleUrl: string | null,
  keepUrl: string | null,
): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl) return;
  if (!isOwnedNutritionGoalImageUrl(staleUrl, scope.prefix)) return;
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
    logger.warn({ err, details, goalId }, 'Replaced nutrition goal image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail under the goal's keys, then points the row at
 * both in one `UPDATE`. A 502 refusal leaves the row on what it had before.
 */
export async function storeNutritionGoalImage(args: {
  scope: NutritionGoalImageScope & { prefix: string };
  goal: NutritionGoalImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { scope, goal, images, modifiedBy } = args;
  const key = buildNutritionGoalImageKey(scope.prefix, goal.id, goal.name);
  const thumbnailKey = buildNutritionGoalImageThumbnailKey(scope.prefix, goal.id, goal.name);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(nutritionGoalImageFolderKeys(scope.prefix));
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error(
      { err, details, diagnostics: getStorageDiagnostics(), gymId: scope.gymId, goalId: goal.id },
      'Cloudflare R2 nutrition goal image upload failed',
    );
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  const owner = ownerWhere(scope);
  await db.query(
    `UPDATE nutrition_goals SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND ${owner.sql}`,
    [url, thumbnailUrl, modifiedBy, goal.id, ...owner.params],
  );
  await sweepReplacedImage(scope, goal.id, goal.image_url, url);
  await sweepReplacedImage(scope, goal.id, goal.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the scope's own objects; others are left alone. */
export async function clearNutritionGoalImage(args: {
  scope: NutritionGoalImageScope;
  goal: NutritionGoalImageRow;
  modifiedBy: string | null;
}): Promise<void> {
  const { scope, goal, modifiedBy } = args;
  const owner = ownerWhere(scope);
  await db.query(
    `UPDATE nutrition_goals SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND ${owner.sql}`,
    [modifiedBy, goal.id, ...owner.params],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(scope, goal.id, goal.image_url, null);
    await sweepReplacedImage(scope, goal.id, goal.image_thumbnail_url, null);
  }
}

/**
 * After a rename: copy both objects to the keys the new name builds, re-point
 * the row in one `UPDATE`, then delete the old objects. Best-effort — a failed
 * copy leaves the row on the old pair, which still renders.
 */
export async function migrateNutritionGoalImageOnRename(
  scope: NutritionGoalImageScope,
  goal: NutritionGoalImageRow,
): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
  const prefix = scope.prefix;
  if (!goal.image_url || !prefix || !isStorageConfigured()) return null;
  if (!isOwnedNutritionGoalImageUrl(goal.image_url, prefix)) return null;

  const oldKey = storageKeyFromObjectUrl(goal.image_url);
  const newKey = buildNutritionGoalImageKey(prefix, goal.id, goal.name);
  const oldThumbKey = goal.image_thumbnail_url && isOwnedNutritionGoalImageUrl(goal.image_thumbnail_url, prefix)
    ? storageKeyFromObjectUrl(goal.image_thumbnail_url)
    : null;
  const newThumbKey = oldThumbKey ? buildNutritionGoalImageThumbnailKey(prefix, goal.id, goal.name) : null;

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
      logger.warn({ err, details, goalId: goal.id }, 'Renamed nutrition goal kept its image on the previous keys: copy failed');
      for (const key of copied) {
        try { await deleteStorageObject(key); } catch { /* an orphan to sweep, never a failure */ }
      }
      return null;
    }
  }

  const newUrl = oldKey && oldKey !== newKey ? (buildStorageObjectUrl(newKey) as string) : goal.image_url;
  const newThumbUrl = newThumbKey && oldThumbKey !== newThumbKey
    ? (buildStorageObjectUrl(newThumbKey) as string)
    : goal.image_thumbnail_url;
  const owner = ownerWhere(scope);
  await db.query(
    `UPDATE nutrition_goals SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND ${owner.sql}`,
    [newUrl, newThumbUrl, goal.id, ...owner.params],
  );
  await sweepReplacedImage(scope, goal.id, goal.image_url, newUrl);
  await sweepReplacedImage(scope, goal.id, goal.image_thumbnail_url, newThumbUrl);
  return { image_url: newUrl, image_thumbnail_url: newThumbUrl };
}

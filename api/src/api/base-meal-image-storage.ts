// The one place a Base Meal's image is written to and cleared from Cloudflare R2
// (#3328). Request parsing, WebP processing and the upload limiter are the Member
// photo's (`member-image-storage.ts`) and are imported, not copied; this module is
// the meal-shaped store / clear around them, as `nutrition-goal-image-storage.ts`
// is for a goal. The key is `cordel/meals/<id>-<slug>.webp`: the slug never
// changes, so — unlike a goal — there is no rename move.

import { db } from '../infra/db';
import {
  baseMealImageFolderKeys,
  buildBaseMealImageKey,
  buildBaseMealImageThumbnailKey,
  isOwnedBaseMealImageUrl,
} from '../domain/baseMeals';
import { MEMBER_IMAGE_STORED_MIME } from '../domain/memberImages';
import type { ProcessedMemberImage } from '../domain/memberImageProcessing';
import type { MemberImageRefusal } from './member-image-storage';
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

export interface BaseMealImageRow {
  id: number;
  slug: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

/** Best-effort removal of an object the meal stopped pointing at, after the row moved. */
async function sweep(mealId: number, staleUrl: string | null, keepUrl: string | null): Promise<void> {
  if (!staleUrl || staleUrl === keepUrl || !isOwnedBaseMealImageUrl(staleUrl)) return;
  const staleKey = storageKeyFromObjectUrl(staleUrl);
  if (!staleKey) return;
  if (keepUrl && storageKeyFromObjectUrl(keepUrl) === staleKey) return;
  try {
    await deleteStorageObject(staleKey);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
    logger.warn({ err, details, mealId }, 'Replaced base meal image left an orphaned object in Cloudflare R2');
  }
}

/**
 * Uploads master and thumbnail under the meal's keys, then points the row at
 * both in one `UPDATE`. A 502 refusal leaves the row on what it had before.
 */
export async function storeBaseMealImage(args: {
  meal: BaseMealImageRow;
  images: ProcessedMemberImage;
  modifiedBy: string | null;
}): Promise<{ image_url: string; image_thumbnail_url: string } | MemberImageRefusal> {
  const { meal, images, modifiedBy } = args;
  const key = buildBaseMealImageKey(meal.id, meal.slug);
  const thumbnailKey = buildBaseMealImageThumbnailKey(meal.id, meal.slug);
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(baseMealImageFolderKeys());
    await uploadStorageObject(key, MEMBER_IMAGE_STORED_MIME, images.image);
    failingKey = thumbnailKey;
    await uploadStorageObject(thumbnailKey, MEMBER_IMAGE_STORED_MIME, images.thumbnail);
  } catch (err: any) {
    const details = err instanceof StorageOperationError
      ? err.details
      : describeStorageError(err, { operation: 'uploadStorageObject', key: failingKey });
    logger.error({ err, details, diagnostics: getStorageDiagnostics(), mealId: meal.id }, 'Cloudflare R2 base meal image upload failed');
    return { status: 502, body: { error: `Failed to upload image: ${details.message}`, details } };
  }

  await db.query(
    `UPDATE base_meals SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ?`,
    [url, thumbnailUrl, modifiedBy, meal.id],
  );
  await sweep(meal.id, meal.image_url, url);
  await sweep(meal.id, meal.image_thumbnail_url, thumbnailUrl);
  return { image_url: url, image_thumbnail_url: thumbnailUrl };
}

/** Clears both references and deletes the meal's own objects. */
export async function clearBaseMealImage(args: { meal: BaseMealImageRow; modifiedBy: string | null }): Promise<void> {
  const { meal, modifiedBy } = args;
  await db.query(
    `UPDATE base_meals SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ?`,
    [modifiedBy, meal.id],
  );
  if (isStorageConfigured()) {
    await sweep(meal.id, meal.image_url, null);
    await sweep(meal.id, meal.image_thumbnail_url, null);
  }
}

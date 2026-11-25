// The one place a Nutrition Goal's image is written to and cleared from
// Cloudflare R2 (#1623, and since #1722 for a Personal Goal too — `scope.kind`
// picks the table and the folder), for both roots: a gym's own goal (`gymId` set, the
// gym's `storage_folder_prefix`) and a System goal (`gymId` null, `cordel`).
// Request parsing, WebP processing, the upload limiter and the 409 for an
// uninitialized bucket are the Member photo's (`member-image-storage.ts`) and are
// imported, not copied; this module is the goal-shaped store / clear
// around them (since #3350 the key carries the goal's slug, so a rename moves nothing), as `plan-image-storage.ts` is for a Membership Plan.

import { db } from '../infra/db';
import { GOAL_LIBRARY_TABLES, type GoalLibraryKind } from '../domain/goalLibrary';
import {
  GOAL_IMAGE_FOLDERS,
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
import { imageKeyIdentifier } from '../domain/imageKeySlug';

export interface NutritionGoalImageRow {
  id: number;
  name: string;
  /**
   * The goal's persisted slug (#3350): what the key carries — a Base goal's
   * `slug`, a gym goal's `entity_slug` (never the gym tables' `slug`, the System
   * label handle). Read from the row when the caller has not passed it.
   */
  slug?: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

/** Where the goal lives: a gym's own (`gymId`) or the platform's (`null`), and the key prefix of its folder. */
export interface NutritionGoalImageScope {
  gymId: string | null;
  prefix: string | null;
  /** #1722: which catalogue the goal is in — its table and its folder. Defaults to Nutrition Goals. */
  kind?: GoalLibraryKind;
  /**
   * #1849 stage 2b: a table that overrides the kind's own — `base_personal_goals`,
   * which has no `gym_id` (every row is the platform's), so the ownership
   * predicate is vacuous there.
   */
  table?: string;
}

function tableOf(scope: NutritionGoalImageScope): string {
  return scope.table ?? GOAL_LIBRARY_TABLES[scope.kind ?? 'nutrition'];
}

function folderOf(scope: NutritionGoalImageScope): string {
  return GOAL_IMAGE_FOLDERS[scope.kind ?? 'nutrition'];
}

/**
 * The column holding a goal's own slug (#2951 stage 3): `slug` on a Base table,
 * `entity_slug` on a gym's table, whose `slug` is the System label handle.
 */
export function goalSlugColumn(scope: NutritionGoalImageScope): 'slug' | 'entity_slug' {
  return scope.table ? 'slug' : 'entity_slug';
}

/** What a goal's image keys carry (#3350): its slug, never its (translated) name. */
export async function goalKeyIdentifier(scope: NutritionGoalImageScope, goal: { id: number; name: string; slug?: string | null }): Promise<string> {
  if (goal.slug !== undefined) return imageKeyIdentifier(goal);
  const { rows } = await db.query<{ slug: string | null }>(
    `SELECT ${goalSlugColumn(scope)} AS slug FROM ${tableOf(scope)} WHERE id = ?`, [goal.id],
  );
  return imageKeyIdentifier({ name: goal.name, slug: rows[0]?.slug ?? null });
}

/** The ownership predicate of the row, so a gym write can never touch a System goal or another gym's. */
function ownerWhere(scope: NutritionGoalImageScope): { sql: string; params: unknown[] } {
  if (scope.table) return { sql: '1 = 1', params: [] };
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
  if (!isOwnedNutritionGoalImageUrl(staleUrl, scope.prefix, folderOf(scope))) return;
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
  const keyId = await goalKeyIdentifier(scope, goal);
  const key = buildNutritionGoalImageKey(scope.prefix, goal.id, keyId, folderOf(scope));
  const thumbnailKey = buildNutritionGoalImageThumbnailKey(scope.prefix, goal.id, keyId, folderOf(scope));
  const url = buildStorageObjectUrl(key) as string;
  const thumbnailUrl = buildStorageObjectUrl(thumbnailKey) as string;

  let failingKey = key;
  try {
    await ensureStorageFolders(nutritionGoalImageFolderKeys(scope.prefix, folderOf(scope)));
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
    `UPDATE ${tableOf(scope)} SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
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
    `UPDATE ${tableOf(scope)} SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE id = ? AND ${owner.sql}`,
    [modifiedBy, goal.id, ...owner.params],
  );
  if (isStorageConfigured()) {
    await sweepReplacedImage(scope, goal.id, goal.image_url, null);
    await sweepReplacedImage(scope, goal.id, goal.image_thumbnail_url, null);
  }
}


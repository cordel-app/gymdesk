// #1850: the one writer of a gym's Personal Goals that come from a Base Personal Goal.
//
// Both gym creation (`POST /gyms`, `POST /gyms/:id/duplicate`) and the Import
// System Personal Goals action (`POST /personal-goals/import`) go through
// `insertPersonalGoalFromTemplate()`, so the two map a template identically.
// The shape is #1851's (`gym-default-products.ts`) one catalogue over:
//
//   * an INSERT and never an UPDATE — a goal the gym edited, deleted or
//     renamed keeps what it holds, and a template change reaches no existing goal;
//   * idempotency is the database's: `UNIQUE (gym_id, base_personal_goal_id)`
//     (migration 315) and the live-name key make a repeated or concurrent import
//     create it once. A deleted imported goal still counts as imported (the
//     unique key would refuse a second one), so it stays deleted;
//   * the copy is the gym's own: no slug (a System row's label handle), the
//     translations and the image objects are copied, never shared by reference.

import { db } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import {
  copyStorageObject,
  describeStorageError,
  ensureStorageFolders,
  isStorageConfigured,
  StorageOperationError,
  storageKeyFromObjectUrl,
} from '../infra/storage';
import { logger } from '../lib/logger';
import {
  GOAL_IMAGE_FOLDERS,
  buildNutritionGoalImageKey,
  buildNutritionGoalImageThumbnailKey,
  nutritionGoalImageFolderKeys,
} from '../domain/nutritionGoalImages';
import { gymStorageFolderPrefix } from './member-image-storage';

export interface BasePersonalGoalRow {
  id: number;
  name: string;
  description: string | null;
  target_value: string | number | null;
  target_unit: string | null;
  target_type: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export interface ImportableBasePersonalGoal extends BasePersonalGoalRow {
  slug: string | null;
  imported: boolean;
  imported_personal_goal_id: number | null;
}

/**
 * Copies the template's image objects into the gym's own keys for the new goal.
 * Best-effort, like Duplicate: a failed copy leaves the goal with no image and an
 * error in the log, never a half-created goal.
 */
export async function copyTemplateImages(
  gymId: string,
  template: BasePersonalGoalRow,
  goalId: number,
): Promise<void> {
  if (!template.image_url) return;
  const sourceKey = storageKeyFromObjectUrl(template.image_url);
  let images: { image_url: string; image_thumbnail_url: string | null } | null = null;
  if (!sourceKey) {
    images = { image_url: template.image_url, image_thumbnail_url: template.image_thumbnail_url };
  } else {
    if (!isStorageConfigured()) return;
    const folderPrefix = await gymStorageFolderPrefix(gymId);
    if (!folderPrefix) return;
    const folder = GOAL_IMAGE_FOLDERS.personal;
    const isWebp = sourceKey.endsWith('.webp');
    const webpKey = buildNutritionGoalImageKey(folderPrefix, goalId, template.name, folder);
    const destKey = isWebp ? webpKey : webpKey.replace(/\.webp$/, sourceKey.slice(sourceKey.lastIndexOf('.')));
    const thumbSourceKey = isWebp && template.image_thumbnail_url ? storageKeyFromObjectUrl(template.image_thumbnail_url) : null;
    try {
      await ensureStorageFolders(nutritionGoalImageFolderKeys(folderPrefix, folder));
      const imageUrl = await copyStorageObject(sourceKey, destKey);
      const thumbUrl = thumbSourceKey
        ? await copyStorageObject(thumbSourceKey, buildNutritionGoalImageThumbnailKey(folderPrefix, goalId, template.name, folder))
        : null;
      images = { image_url: imageUrl, image_thumbnail_url: thumbUrl };
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'copyStorageObject', key: destKey });
      logger.error({ err, details, gymId, goalId, sourceKey }, 'Importing a Base Personal Goal could not copy its image');
      return;
    }
  }
  await db.query(
    'UPDATE personal_goals SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?',
    [images.image_url, images.image_thumbnail_url, goalId, gymId],
  );
}

/**
 * Creates one gym-owned Personal Goal from a `base_personal_goals` template and
 * records the template in `personal_goals.base_personal_goal_id`. Returns whether
 * a goal was created (false when the gym already has it, or has a live goal of
 * that name).
 */
export async function insertPersonalGoalFromTemplate(
  gymId: string,
  template: BasePersonalGoalRow,
  actor: string | null,
): Promise<boolean> {
  const { rowCount, insertId } = await db.query(
    `INSERT IGNORE INTO personal_goals
       (gym_id, base_personal_goal_id, name, description, target_value, target_unit, target_type,
        status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(), ?)`,
    [
      gymId, template.id, template.name, template.description,
      template.target_value, template.target_unit, template.target_type, actor,
    ],
  );
  if (rowCount === 0) return false;

  await db.query(
    `INSERT IGNORE INTO personal_goal_translations (personal_goal_id, locale, name, description)
     SELECT ?, locale, name, description FROM base_personal_goal_translations WHERE base_personal_goal_id = ?`,
    [insertId, template.id],
  );
  await db.query(
    `INSERT IGNORE INTO gym_personal_goals (gym_id, personal_goal_id, status, created_by)
     VALUES (?, ?, 'active', ?)`,
    [gymId, insertId, actor],
  );
  await copyTemplateImages(gymId, template, insertId);
  return true;
}

/** The live templates and, for the given gym, which are already a goal of it (any status). */
export async function listBasePersonalGoalsForGym(gymId: string, q?: string): Promise<ImportableBasePersonalGoal[]> {
  const params: unknown[] = [gymId];
  let where = 'b.deleted_at IS NULL';
  if (q) {
    where += ' AND (b.name LIKE ? OR b.description LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const { rows } = await db.query<any>(
    `SELECT b.*,
       (SELECT g.id FROM personal_goals g WHERE g.gym_id = ? AND g.base_personal_goal_id = b.id LIMIT 1)
         AS imported_personal_goal_id
     FROM base_personal_goals b
     WHERE ${where}
     ORDER BY b.name, b.id`,
    params,
  );
  return rows.map((r: any) => ({
    ...r,
    imported: r.imported_personal_goal_id !== null,
    imported_personal_goal_id: r.imported_personal_goal_id === null ? null : Number(r.imported_personal_goal_id),
  }));
}

/** Imports the chosen live templates; reports what it created and what it skipped. */
export async function importBasePersonalGoals(
  gymId: string,
  baseIds: number[],
  actor: string | null,
): Promise<{ imported: number[]; skipped: number[] }> {
  const imported: number[] = [];
  const skipped: number[] = [];
  const available = await listBasePersonalGoalsForGym(gymId);
  for (const id of baseIds) {
    const template = available.find((t) => t.id === id);
    if (!template || template.imported) {
      skipped.push(id);
      continue;
    }
    (await insertPersonalGoalFromTemplate(gymId, template, actor)) ? imported.push(id) : skipped.push(id);
  }
  return { imported, skipped };
}

/** Creates the Personal Goals a new gym starts with: every live Base Personal Goal. Safe to re-run. */
export async function seedDefaultGymPersonalGoals(gymId: string, actor: string | null = SYSTEM_ACTOR): Promise<void> {
  const { rows } = await db.query<BasePersonalGoalRow>(
    'SELECT * FROM base_personal_goals WHERE deleted_at IS NULL ORDER BY id',
  );
  for (const template of rows) {
    await insertPersonalGoalFromTemplate(gymId, template, actor);
  }
}

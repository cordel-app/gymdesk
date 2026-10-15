// Where a **Nutrition Goal**'s image lives and which objects may be deleted
// (#1623). The pipeline is the Membership Plan's (#1514) and the Member photo's
// (#1449) — a WebP master and a WebP thumbnail the server makes from one
// uploaded original — so request judgement, processing and upload limits are
// `member-image-storage.ts`' and `memberImageProcessing.ts`'; this file owns only
// *where a goal's image goes* and *what may be removed*. Pure: no database, no
// bucket.
//
// One shape for both roots, one root apart: `<prefix>/nutrition_goals/<id>-<name>.webp`
// with the gym's `storage_folder_prefix` for a gym goal and `cordel` for a
// System one (`docs/cloudflare_structure.md`).

import {
  NUTRITION_GOALS_FOLDER,
  PLATFORM_STORAGE_ROOT,
  sanitizeStorageObjectName,
  storageKeyFromObjectUrl,
} from '../infra/storage';

export { NUTRITION_GOALS_FOLDER };

/** Same cap as a member's or plan's name in a key, for the same VARCHAR(1024) reason. */
const MAX_KEY_NAME_CHARS = 80;

/** A goal's name as it appears in an object key: `Weight Loss` → `Weight-Loss`. */
export function sanitizeNutritionGoalImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'goal').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/**
 * `<prefix>/nutrition_goals/<goal_id>-<sanitized name>.webp` — the 1080 × 1080
 * master. `prefix` is the gym's folder prefix, or {@link PLATFORM_STORAGE_ROOT}
 * for a System goal. Deterministic, so a replacement overwrites its own object
 * and the id keeps two goals with one name apart.
 */
export function buildNutritionGoalImageKey(prefix: string, goalId: number | string, name: string): string {
  return `${prefix}/${NUTRITION_GOALS_FOLDER}/${goalId}-${sanitizeNutritionGoalImageName(name)}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildNutritionGoalImageThumbnailKey(prefix: string, goalId: number | string, name: string): string {
  return `${prefix}/${NUTRITION_GOALS_FOLDER}/${goalId}-${sanitizeNutritionGoalImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `nutrition_goals/`, outermost first. */
export function nutritionGoalImageFolderKeys(prefix: string): string[] {
  return [`${prefix}/`, `${prefix}/${NUTRITION_GOALS_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **under `prefix`'s `nutrition_goals/`**
 * and so may be deleted when a goal's image is replaced, moved or removed
 * (#719 §19, narrowed to this feature): another gym's folder, the platform's
 * (from a gym), another feature's object and an external URL are all false.
 */
export function isOwnedNutritionGoalImageUrl(
  url: string | null | undefined,
  prefix: string | null | undefined,
): boolean {
  if (!url || !prefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${prefix}/${NUTRITION_GOALS_FOLDER}/`);
}

/** The platform's prefix for a System goal's image. */
export const PLATFORM_NUTRITION_GOALS_PREFIX = PLATFORM_STORAGE_ROOT;

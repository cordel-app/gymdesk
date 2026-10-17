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
  GOALS_FOLDER,
  NUTRITION_GOALS_FOLDER,
  PLATFORM_STORAGE_ROOT,
  sanitizeStorageObjectName,
  storageKeyFromObjectUrl,
} from '../infra/storage';

export { NUTRITION_GOALS_FOLDER };

/**
 * #1722 — the same pipeline serves a Personal Goal, whose folder is `goals/`
 * (the one the PNG implementation kept it in, so a pre-#1722 object is still
 * under its owner's own folder and is swept when its image is replaced). A goal
 * kind's folder is declared here and nowhere else; every builder below takes it
 * as a trailing argument defaulting to `nutrition_goals/`.
 */
export const GOAL_IMAGE_FOLDERS = { nutrition: NUTRITION_GOALS_FOLDER, personal: GOALS_FOLDER } as const;
export type GoalImageKind = keyof typeof GOAL_IMAGE_FOLDERS;

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
export function buildNutritionGoalImageKey(
  prefix: string, goalId: number | string, name: string, folder: string = NUTRITION_GOALS_FOLDER,
): string {
  return `${prefix}/${folder}/${goalId}-${sanitizeNutritionGoalImageName(name)}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildNutritionGoalImageThumbnailKey(
  prefix: string, goalId: number | string, name: string, folder: string = NUTRITION_GOALS_FOLDER,
): string {
  return `${prefix}/${folder}/${goalId}-${sanitizeNutritionGoalImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `nutrition_goals/`, outermost first. */
export function nutritionGoalImageFolderKeys(prefix: string, folder: string = NUTRITION_GOALS_FOLDER): string[] {
  return [`${prefix}/`, `${prefix}/${folder}/`];
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
  folder: string = NUTRITION_GOALS_FOLDER,
): boolean {
  if (!url || !prefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${prefix}/${folder}/`);
}

/** The platform's prefix for a System goal's image. */
export const PLATFORM_NUTRITION_GOALS_PREFIX = PLATFORM_STORAGE_ROOT;

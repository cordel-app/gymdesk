// Where a **Base Exercise's** image lives, and which objects a platform
// operation is allowed to delete (#716).
//
// A Base Exercise is an `exercises` row with `gym_id IS NULL`: it belongs to no
// gym, so its media cannot hang off `gyms.storage_folder_prefix` (#716 §1, §15).
// It goes in the platform's own folder instead — `PLATFORM_STORAGE_ROOT`, the
// `cordel` sibling of the `gyms/` root that #732 and #715 already use — under
// the same `Exercises/Images` leaf a gym uses inside its own tree.
//
// Everything here is pure: the object keys and the ownership test. What counts
// as a *valid* image is not duplicated — a Base Exercise image is the same
// 2048×2048 master plus 512×512 thumbnail as a Gym Exercise's (#716 §2, §3 are
// #719 §5 word for word), so the rules stay in `exerciseImages.ts` and both
// routers call the one implementation.

import { PLATFORM_STORAGE_ROOT, storageKeyFromObjectUrl } from '../infra/storage';
import { EXERCISE_IMAGES_FOLDER, sanitizeExerciseImageName } from './exerciseImages';

/**
 * `cordel/Exercises/Images` — the one folder every Base Exercise image is stored
 * in (#716 §1). The leaf is spelled once, in `exerciseImages.ts`: a gym's
 * `<prefix>/Exercises/Images/` and this are the same branch of two different
 * roots, and they must never be confused for one another (§15).
 */
export const PLATFORM_EXERCISE_IMAGES_PREFIX = `${PLATFORM_STORAGE_ROOT}/${EXERCISE_IMAGES_FOLDER}`;

/**
 * `cordel/Exercises/Images/<exercise_id>-<sanitized name>.png` — the key a Base
 * Exercise's **master** image is stored under (#716 §13).
 *
 * The id leads, so two exercises whose names sanitize alike never share an
 * object, and the `.png` is part of the fixed name rather than a claim about the
 * bytes: only PNG is accepted, so the two cannot disagree. The uploaded file's
 * own name plays no part in the key (#713's rule), and neither does anything
 * else the request carries — the key is derived from the row (§14).
 */
export function buildBaseExerciseImageKey(exerciseId: number | string, name: string): string {
  return `${PLATFORM_EXERCISE_IMAGES_PREFIX}/${exerciseId}-${sanitizeExerciseImageName(name)}.png`;
}

/** The same key with `-thumbnail` before the extension — the 512×512 companion (#716 §13). */
export function buildBaseExerciseImageThumbnailKey(exerciseId: number | string, name: string): string {
  return `${PLATFORM_EXERCISE_IMAGES_PREFIX}/${exerciseId}-${sanitizeExerciseImageName(name)}-thumbnail.png`;
}

/**
 * Every folder marker between the bucket root and `cordel/Exercises/Images/`,
 * outermost first. R2 has no directories, so these are the zero-byte `…/`
 * objects `ensureStorageFolders()` writes; Gym Bucket Initialization only writes
 * a *gym's* tree, so the platform root is created by the first upload that needs
 * it (same as `baseNutritionFolderKeys()`, #715).
 */
export function baseExerciseImageFolderKeys(): string[] {
  return [
    `${PLATFORM_STORAGE_ROOT}/`,
    `${PLATFORM_STORAGE_ROOT}/Exercises/`,
    `${PLATFORM_EXERCISE_IMAGES_PREFIX}/`,
  ];
}

/**
 * Whether the object behind `url` is one the **platform** owns, and may
 * therefore delete when a Base Exercise's image is replaced or removed.
 *
 * The mirror image of `isGymOwnedImageUrl()` (#719 §19): true only for a URL
 * this deployment built (`storageKeyFromObjectUrl()` — a different endpoint or
 * bucket is already "not ours") whose key sits under `cordel/Exercises/Images/`.
 * So:
 *
 *  - `…/cordel/Exercises/Images/…` → true, the platform's own upload.
 *  - `…/gyms/<a gym>/…` → **false**: a gym's object, which a platform operation
 *    must never delete. Nothing should put one on a base row, and a `PUT` that
 *    sets `image_url` to any string is exactly what could.
 *  - `…/cordel/Nutrition/…` → false. Another feature's object is not this one's
 *    to delete either, however platform-owned it is.
 *  - a hand-typed external URL → false; there is no object of ours to delete.
 */
export function isPlatformOwnedExerciseImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${PLATFORM_EXERCISE_IMAGES_PREFIX}/`);
}

// Where a **Base Exercise's** image lives, and which objects a platform
// operation is allowed to delete (#716).
//
// A Base Exercise is an `exercises` row with `gym_id IS NULL`: it belongs to no
// gym, so its media cannot hang off `gyms.storage_folder_prefix` (#716 §1, §15).
// It goes in the platform's own folder instead — `PLATFORM_STORAGE_ROOT`, the
// `cordel` sibling of the `gyms/` root that #732 and #715 already use — under
// the same `exercises/images` leaf a gym uses inside its own tree.
//
// Since #1420 the keys and the upload rules of a Base Exercise's media are
// `exerciseGenderMedia.ts`'s; what remains here is the platform prefix and the
// ownership test other features (members, goals) reuse.

import { PLATFORM_STORAGE_ROOT, storageKeyFromObjectUrl } from '../infra/storage';
import { EXERCISE_IMAGES_FOLDER } from './exerciseImages';

/**
 * `cordel/exercises/images` — the one folder every Base Exercise image is stored
 * in (#716 §1). The leaf is spelled once, in `exerciseImages.ts`: a gym's
 * `<prefix>/Exercises/Images/` and this are the same branch of two different
 * roots, and they must never be confused for one another (§15).
 */
export const PLATFORM_EXERCISE_IMAGES_PREFIX = `${PLATFORM_STORAGE_ROOT}/${EXERCISE_IMAGES_FOLDER}`;

/**
 * Whether the object behind `url` is one the **platform** owns, and may
 * therefore delete when a Base Exercise's image is replaced or removed.
 *
 * The mirror image of `isGymOwnedImageUrl()` (#719 §19): true only for a URL
 * this deployment built (`storageKeyFromObjectUrl()` — a different endpoint or
 * bucket is already "not ours") whose key sits under `cordel/exercises/images/`.
 * So:
 *
 *  - `…/cordel/exercises/images/…` → true, the platform's own upload.
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

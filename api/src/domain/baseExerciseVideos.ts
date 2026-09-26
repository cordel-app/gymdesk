// Where a **Base Exercise's** video and its poster live, and which objects a
// platform operation is allowed to delete (#717).
//
// The sibling of `baseExerciseImages.ts` (#716), one folder over, and built the
// same way: a Base Exercise is an `exercises` row with `gym_id IS NULL`, so it
// belongs to no gym and its media cannot hang off `gyms.storage_folder_prefix`
// (#717 §1). It goes in the platform's own folder instead —
// `PLATFORM_STORAGE_ROOT`, the `cordel` sibling of the `gyms/` root — under the
// same `Exercises/Videos` leaf a gym uses inside its own tree (#719 §18).
//
// Everything here is pure: the object keys and the ownership test. What counts
// as a *valid* upload is not duplicated — a Base Exercise video is the same MP4
// plus 512×512 poster as a Gym Exercise's, validated by the same rules, so they
// stay in `exerciseVideos.ts` and both routers call the one implementation
// (#717 Q3: reuse `domain/mp4Video.ts`, no `ffprobe` in the API image).

import { PLATFORM_STORAGE_ROOT, storageKeyFromObjectUrl } from '../infra/storage';
import { sanitizeExerciseImageName } from './exerciseImages';
import { EXERCISE_VIDEOS_FOLDER } from './exerciseVideos';

/**
 * `cordel/Exercises/Videos` — the one folder every Base Exercise video is stored
 * in (#717 §1). The leaf is spelled once, in `exerciseVideos.ts`: a gym's
 * `<prefix>/Exercises/Videos/` and this are the same branch of two different
 * roots, and they must never be confused for one another.
 */
export const PLATFORM_EXERCISE_VIDEOS_PREFIX = `${PLATFORM_STORAGE_ROOT}/${EXERCISE_VIDEOS_FOLDER}`;

/**
 * `cordel/Exercises/Videos/<exercise_id>-<sanitized name>.mp4` — the key a Base
 * Exercise's video is stored under (#717 §1).
 *
 * The id leads, so two exercises whose names sanitize alike never share an
 * object, and the `.mp4` is part of the fixed name rather than a claim about the
 * bytes: only MP4 is accepted, so the two cannot disagree. The uploaded file's
 * own name plays no part in the key (#713's rule) — the key is derived from the
 * row, which is what keeps anything a client sends out of a gym's folder.
 */
export function buildBaseExerciseVideoKey(exerciseId: number | string, name: string): string {
  return `${PLATFORM_EXERCISE_VIDEOS_PREFIX}/${exerciseId}-${sanitizeExerciseImageName(name)}.mp4`;
}

/**
 * The poster's key — `…-thumbnail.png` beside the video (#717 Q4), so a list can
 * draw a video without downloading the MP4 (§9). It is the answer to Q4 that
 * makes this pair mandatory rather than optional: without a System poster,
 * `POST /exercises/import` has nothing to copy for a gym's System-sourced
 * exercise (#719 §2).
 */
export function buildBaseExerciseVideoPosterKey(exerciseId: number | string, name: string): string {
  return `${PLATFORM_EXERCISE_VIDEOS_PREFIX}/${exerciseId}-${sanitizeExerciseImageName(name)}-thumbnail.png`;
}

/**
 * Every folder marker between the bucket root and `cordel/Exercises/Videos/`,
 * outermost first. R2 has no directories, so these are the zero-byte `…/`
 * objects `ensureStorageFolders()` writes; Gym Bucket Initialization only writes
 * a *gym's* tree, so the platform root is created by the first upload that needs
 * it (same as `baseExerciseImageFolderKeys()`, #716).
 */
export function baseExerciseVideoFolderKeys(): string[] {
  return [
    `${PLATFORM_STORAGE_ROOT}/`,
    `${PLATFORM_STORAGE_ROOT}/Exercises/`,
    `${PLATFORM_EXERCISE_VIDEOS_PREFIX}/`,
  ];
}

/**
 * Whether the object behind `url` is one the **platform** owns, and may
 * therefore delete when a Base Exercise's video is replaced or removed.
 *
 * The mirror of `isPlatformOwnedExerciseImageUrl()` (#716) one folder over: true
 * only for a URL this deployment built (`storageKeyFromObjectUrl()` — a
 * different endpoint or bucket is already "not ours") whose key sits under
 * `cordel/Exercises/Videos/`. So:
 *
 *  - `…/cordel/Exercises/Videos/…` → true, the platform's own upload.
 *  - `…/gyms/<a gym>/…` → **false**: a gym's object, which a platform operation
 *    must never delete. A `PUT` that sets `video_url` to any string is exactly
 *    what could put one on a base row.
 *  - `…/cordel/Exercises/Images/…` → false. The image sweep owns that folder;
 *    neither is the other's to delete, however platform-owned both are.
 *  - a YouTube link, or any other external URL → false; there is no object of
 *    ours to delete.
 */
export function isPlatformOwnedExerciseVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${PLATFORM_EXERCISE_VIDEOS_PREFIX}/`);
}

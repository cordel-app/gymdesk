// Which objects in an exercise media folder are legacy test data (#1420, last stage).
//
// Before #1420 an exercise's media was one 2048 PNG pair (`<id>-<name>.png` and
// `-thumbnail.png`) and one MP4 with a 512 PNG poster, referenced by the
// `image_url` / `video_url` columns the last stage drops. The product owner
// confirmed all of it is test data and none of it is carried over, so the objects
// are removed from the bucket by an operator script (`scripts/purge-legacy-
// exercise-media.ts`) rather than by a migration, which may not talk to R2.
//
// The decision is pure and lives here: given a key, is it a legacy object? It is
// derived from the **key alone** — not from the dropped columns — so the script
// can run before or after the migration, and a second run finds nothing to do.
//
// Only the exercise media folders are ever scanned, and the gender-specific
// objects (`…-male.webp`, `…-female-thumbnail.webp`, `…-male.mp4`, …) are never
// legacy. A zero-byte folder marker (a key ending in `/`) is not an object.

import { EXERCISE_FOLDER, EXERCISE_IMAGES_FOLDER } from './exerciseImages';
import { EXERCISE_VIDEOS_FOLDER } from './exerciseVideos';

/** `<id>-<name>-male.webp`, `…-female-thumbnail.webp`, `…-male.mp4`: what #1420 writes. */
const GENDERED_KEY = /-(?:male|female)(?:-thumbnail)?\.(?:webp|mp4)$/;

/**
 * The folders an exercise object may be in, below a root (`cordel` or a gym's
 * `storage_folder_prefix`). The capitalised pair is the pre-#1035 spelling a row
 * written before that ticket may still point at; nothing writes it any more, so
 * everything in it is legacy.
 */
export function exerciseMediaFolders(root: string): { folder: string; legacyCase: boolean }[] {
  return [
    { folder: `${root}/${EXERCISE_FOLDER}/${EXERCISE_IMAGES_FOLDER.split('/').pop()}/`, legacyCase: false },
    { folder: `${root}/${EXERCISE_FOLDER}/${EXERCISE_VIDEOS_FOLDER.split('/').pop()}/`, legacyCase: false },
    { folder: `${root}/Exercises/Images/`, legacyCase: true },
    { folder: `${root}/Exercises/Videos/`, legacyCase: true },
  ];
}

/** Whether `key`, found under one of `exerciseMediaFolders()`, is a legacy object to remove. */
export function isLegacyExerciseMediaKey(key: string, legacyCase: boolean): boolean {
  if (!key || key.endsWith('/')) return false;
  if (legacyCase) return true;
  return !GENDERED_KEY.test(key);
}

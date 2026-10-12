// The pieces of exercise media storage every feature shares (#719, #1420): the
// folder names, how an exercise name appears in an object key, and which objects
// a gym operation is allowed to delete.
//
// The legacy 2048 PNG pair and its upload rules were removed with the legacy
// columns in #1420's last stage; the keys and the upload rules of the
// gender-specific media are `exerciseGenderMedia.ts`'s.

import {
  EXERCISE_IMAGES_STORAGE_FOLDER,
  EXERCISE_STORAGE_FOLDER,
  sanitizeStorageObjectName,
  storageKeyFromObjectUrl,
} from '../infra/storage';

/**
 * `exercises` — the first-level folder every kind of exercise media hangs off.
 * Re-exported from `infra/storage.ts` rather than restated, because Gym Bucket
 * Initialization writes the very markers these keys are written into and a name
 * spelled twice could diverge in case alone (#1035, the `THEMES_FOLDER` rule).
 */
export const EXERCISE_FOLDER = EXERCISE_STORAGE_FOLDER;

/**
 * `exercises/images` — the leaf of the gym's own folder tree (`GYM_FOLDERS` in
 * `infra/storage.ts`, written at Gym Bucket Initialization) that holds exercise
 * images. #719 §18 fixes it: a gym's upload goes here and never under
 * `cordel/exercises/images/`, which stays the platform's.
 */
export const EXERCISE_IMAGES_FOLDER = EXERCISE_IMAGES_STORAGE_FOLDER;

/**
 * How much of the exercise name a key may carry. `exercises.name` is
 * VARCHAR(200) and a gym's folder prefix is itself built from a VARCHAR(255)
 * gym name, so an uncapped key can outgrow the VARCHAR(512) columns that store
 * the resulting URLs — and the row is written *after* the objects are in R2, so
 * the overflow would leave an orphan and a 500 rather than a clean rejection.
 * Capping here bounds both URLs by construction; the id in front of the name is
 * what keeps two long names that truncate alike from sharing an object.
 */
const MAX_KEY_NAME_CHARS = 80;

/** An exercise name as it appears in an object key (`Barbell Press` → `Barbell-Press`). */
export function sanitizeExerciseImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'exercise').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

// ─── Ownership (#719 §19) ─────────────────────────────────────────────────────

/**
 * Whether the object behind `url` is one **this gym** owns, and may therefore
 * delete when it is replaced or removed.
 *
 * True only for a URL this deployment built (`storageKeyFromObjectUrl()` — a
 * different endpoint or bucket is already "not ours") whose key sits under the
 * gym's own `storage_folder_prefix`. So:
 *
 *  - `…/gyms/<this gym>/exercises/images/…` → true, the gym's own upload,
 *    including the `<uuid>.png` shape `POST /storage/uploads/exercise-image`
 *    (#417) has always written.
 *  - `…/cordel/exercises/images/…` → **false**: platform media, which a gym
 *    operation must never delete (§19), and which a gym exercise legitimately
 *    points at after an import (§2).
 *  - `…/gyms/<another gym>/…` → false. Nothing should produce this, and a gym
 *    reaching into another's folder is exactly what must not happen if something
 *    did.
 *  - a hand-typed external URL → false; there is no object of ours to delete.
 *
 * The prefix comparison is anchored with a trailing `/` so `gyms/<id>-Fit` can
 * never match `gyms/<other id>-FitnessPlus`.
 */
export function isGymOwnedImageUrl(url: string | null | undefined, folderPrefix: string | null | undefined): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/`);
}

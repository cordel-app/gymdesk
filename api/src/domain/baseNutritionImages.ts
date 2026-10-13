// Where a **Nutrition Library** food's image lives, and what counts as a valid
// base one (#715, #1035).
//
// Both roots are here on purpose: a base food's image and a gym food's image are
// the same `nutrition/<food_id>-<name>` shape one root apart (#1035 §4/§12), so
// the two keys are built from one folder constant and one sanitizer rather than
// drifting in two modules.
//
// Everything here is pure: the object key, the sanitizer that feeds it and the
// upload rules. The router owns the bytes, the row and the authorization — this
// file owns *where an image goes* and *what is accepted*, so both are decided in
// one place and can be unit-tested without a database or a bucket.

import {
  NUTRITION_STORAGE_FOLDER,
  PLATFORM_STORAGE_ROOT,
  sanitizeStorageObjectName,
} from '../infra/storage';
import { thumbnailKeyFor } from './exerciseGenderMedia';

/**
 * `nutrition`: the one folder a Nutrition Library food's image lives in, under
 * the platform root for a base food and under the gym's own prefix for a gym
 * food. Base foods are `gym_id IS NULL` rows and belong to no gym, so they
 * cannot hang off `gyms.storage_folder_prefix`; their prefix is
 * {@link PLATFORM_STORAGE_ROOT} (`cordel`), the sibling of the `gyms/` root that
 * #732 already uses for Base Theme assets.
 *
 * It was `Nutrition` under the platform root until 2026-09-27 and
 * `Nutrition/Images` under a gym's until #1035 — which also dropped the
 * `Images/` leaf, since a food's image is the only thing that folder ever held.
 * Objects stored under either old name still resolve through their row's URL,
 * and the next upload of that food moves it here and deletes the old object
 * (#1035 §6: nothing migrates an object a row still points at).
 */
export const NUTRITION_FOLDER = NUTRITION_STORAGE_FOLDER;

/**
 * Kept under its old name because it reads as the platform's half of the pair.
 * @deprecated prefer {@link NUTRITION_FOLDER}, which is both roots'.
 */
export const PLATFORM_NUTRITION_FOLDER = NUTRITION_FOLDER;

/** `cordel/nutrition`: the one folder every base food's image is stored in. */
export const PLATFORM_NUTRITION_PREFIX = `${PLATFORM_STORAGE_ROOT}/${NUTRITION_FOLDER}`;

/**
 * A food name as it appears in an object key: `Salmon, Atlantic` →
 * `Salmon-Atlantic`, `Chicken Breast` → `Chicken-Breast`.
 *
 * Deliberately *not* `sanitizeStorageFolderName()`, which deletes whitespace
 * outright (`ChickenBreast`): #715 §10 spells the expected results with hyphens,
 * and a food name is a phrase rather than a folder label. The rules, in order:
 *
 *  1. Anything that is not a letter, digit, `_` or `-` becomes a separator —
 *     spaces, commas, `%`, `/`, accents and any other character that would have
 *     to be escaped in a URL.
 *  2. Runs of separators collapse to a single `-`, and leading/trailing ones go.
 *  3. Empty result (a name of nothing but punctuation) falls back to `food`, so
 *     the key can never end up as `cordel/nutrition/<id>-.webp`.
 *
 * Deterministic and case-preserving: the same name always yields the same
 * name part of the key.
 *
 * The rule itself is {@link sanitizeStorageObjectName} (#719 gave it a second
 * caller, Gym Exercise images); only the fallback word is this feature's.
 */
export function sanitizeNutritionImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'food');
}

/**
 * `cordel/nutrition/<food_id>-<sanitized name>.webp`: the key a base food's image
 * is stored under (#1035 §4/§12).
 *
 * The id leads, so two foods whose names sanitize alike never share an object —
 * the same shape the exercise keys use, and the one #1035's target tree spells.
 * It was a fresh UUID per upload until that ticket, which made every upload a
 * new key; the key is deterministic now, so replacing an image overwrites the
 * object in place and the caller has nothing to sweep unless the food was
 * renamed. A surface showing the image therefore cache-busts on the row's own
 * `modified_at`, as Cordel's Base Nutrition Library page already does.
 *
 * Since #1562 the object is always the server-made 1080 × 1080 WebP master (its
 * 256 × 256 thumbnail sits beside it, {@link nutritionThumbnailKeyFor}); the
 * uploaded file's own name and format play no part in the key (#713's rule).
 */
export function buildBaseNutritionImageKey(foodId: number | string, foodName: string): string {
  return `${PLATFORM_NUTRITION_PREFIX}/${foodId}-${sanitizeNutritionImageName(foodName)}.webp`;
}

/**
 * `<gym prefix>/nutrition/<food_id>-<sanitized name>.<ext>`: the key a **gym**
 * food's image is stored under (#1035 §4, §5, §12).
 *
 * The same shape one root over. Both roots are `.webp` since #1562, because the
 * server converts whatever was uploaded.
 *
 * Deterministic like the base key, so replacing an image reuses the key and a
 * rename is what leaves an object to sweep.
 */
export function buildGymNutritionImageKey(
  folderPrefix: string,
  foodId: number | string,
  foodName: string,
): string {
  return `${folderPrefix}/${NUTRITION_FOLDER}/${foodId}-${sanitizeNutritionImageName(foodName)}.webp`;
}

/**
 * Every folder marker between the bucket root and `cordel/nutrition/`, outermost
 * first. R2 has no directories, so these are the zero-byte `…/` objects
 * `ensureStorageFolders()` writes; the platform root is not created by Gym
 * Bucket Initialization (that only writes a gym's tree), so the first upload
 * writes it. #1035 §2/§7 is about *initialization*: the platform tree is created
 * by hand in the Cloudflare console, and these upload-time markers are what make
 * a branch nobody has created yet visible in the bucket browser.
 */
export function baseNutritionFolderKeys(): string[] {
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_NUTRITION_PREFIX}/`];
}

/**
 * The same belt-and-braces markers for a **gym**'s `nutrition/` branch. Gym
 * Bucket Initialization already writes both (`GYM_FOLDERS`), so this only covers
 * a gym whose tree predates the folder or was initialized against a different
 * bucket — rewriting a marker is a no-op.
 */
export function gymNutritionFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${NUTRITION_FOLDER}/`];
}

/**
 * The 256 × 256 thumbnail key beside a food's master key (#1562):
 * `<id>-<name>.webp` → `<id>-<name>-thumbnail.webp`. Derived, never stored, so a
 * food has one image column and the pair cannot disagree.
 */
export function nutritionThumbnailKeyFor(masterKey: string): string {
  return thumbnailKeyFor(masterKey);
}

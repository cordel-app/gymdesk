// Where a **Base Nutrition Library** food's image lives, and what counts as a
// valid one (#715).
//
// Everything here is pure: the object key, the sanitizer that feeds it and the
// upload rules. The router owns the bytes, the row and the authorization — this
// file owns *where an image goes* and *what is accepted*, so both are decided in
// one place and can be unit-tested without a database or a bucket.

import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import { readPngMetadata, pngSupportsTransparency } from './pngImage';

/**
 * `Nutrition` — the branch of the platform root that holds Base Nutrition
 * Library images. Base foods are `gym_id IS NULL` rows and belong to no gym, so
 * they cannot hang off `gyms.storage_folder_prefix`; their prefix is
 * {@link PLATFORM_STORAGE_ROOT} (`cordel`), the sibling of the `gyms/` root that
 * #732 already uses for Base Theme assets. A gym's *own* nutrition images keep
 * using `<gym prefix>/Nutrition/Images/` and are untouched by this.
 */
export const PLATFORM_NUTRITION_FOLDER = 'Nutrition';

/** `cordel/Nutrition` — the one folder every base food's image is stored in. */
export const PLATFORM_NUTRITION_PREFIX = `${PLATFORM_STORAGE_ROOT}/${PLATFORM_NUTRITION_FOLDER}`;

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
 *     the key can never end up as `cordel/Nutrition/12-.png`.
 *
 * Deterministic and case-preserving: the same name always yields the same key,
 * which is what makes a re-upload overwrite rather than orphan.
 */
export function sanitizeNutritionImageName(name: string): string {
  const sanitized = (name ?? '')
    .normalize('NFD')
    // Strip combining marks so `Jamón` reads as `Jamon` rather than `Jam-n`.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized.length > 0 ? sanitized : 'food';
}

/**
 * `cordel/Nutrition/<food_id>-<sanitized name>.png` — the one key a base food's
 * image is stored under (#715 §1).
 *
 * The id leads, so two foods that sanitize to the same name never share an
 * object, and the `.png` is part of the fixed name rather than a claim about the
 * bytes: only PNG is accepted, so the two can't disagree. The uploaded file's
 * own name plays no part in the key (#713's rule).
 */
export function buildBaseNutritionImageKey(foodId: number, foodName: string): string {
  return `${PLATFORM_NUTRITION_PREFIX}/${foodId}-${sanitizeNutritionImageName(foodName)}.png`;
}

/**
 * Every folder marker between the bucket root and `cordel/Nutrition/`, outermost
 * first. R2 has no directories, so these are the zero-byte `…/` objects
 * `ensureStorageFolders()` writes; the platform root is not created by Gym
 * Bucket Initialization (that only writes a gym's tree), so the first upload
 * writes it.
 */
export function baseNutritionFolderKeys(): string[] {
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_NUTRITION_PREFIX}/`];
}

// ─── Upload rules (#715 §2, §8) ──────────────────────────────────────────────

/** PNG only: the slot's key is named `.png` and §2 fixes the format. */
export const BASE_NUTRITION_IMAGE_MIME = 'image/png';

/** 512 × 512, square — the exact size §2 specifies, enforced from the IHDR. */
export const BASE_NUTRITION_IMAGE_SIZE = 512;

/**
 * 2 MB. A 512×512 PNG of a single food is a few tens of KB; the ceiling exists
 * because the bytes are buffered in the API process (`express.raw`), so it is
 * generous rather than tight.
 */
export const BASE_NUTRITION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Why an upload was refused — the router maps each to a status and a message. */
export type BaseNutritionImageRejection =
  | 'not_a_png'
  | 'not_square_512'
  | 'not_transparent';

/**
 * Whether these bytes may replace a base food's image, and if not, why.
 *
 * Validated from the file, never from the request: the `Content-Type` header and
 * the file name are both the client's word, and #715 §8 requires the server to
 * check independently of the browser. A rejection means nothing is uploaded and
 * nothing is written, so the existing image stays exactly as it was.
 */
export function validateBaseNutritionImage(body: unknown): BaseNutritionImageRejection | null {
  const metadata = readPngMetadata(body);
  if (!metadata) return 'not_a_png';
  if (metadata.width !== BASE_NUTRITION_IMAGE_SIZE || metadata.height !== BASE_NUTRITION_IMAGE_SIZE) {
    return 'not_square_512';
  }
  if (!pngSupportsTransparency(metadata)) return 'not_transparent';
  return null;
}

/** Human-readable reason for each rejection, as the API returns it. */
export const BASE_NUTRITION_IMAGE_REJECTION_MESSAGES: Record<BaseNutritionImageRejection, string> = {
  not_a_png: 'Image must be a PNG file',
  not_square_512: `Image must be exactly ${BASE_NUTRITION_IMAGE_SIZE}×${BASE_NUTRITION_IMAGE_SIZE} pixels`,
  not_transparent: 'Image must have a transparent background (an alpha channel)',
};

// Where a **Gym Exercise** image lives, what counts as a valid one, and which
// objects a gym operation is allowed to delete (#719 part 1).
//
// Everything here is pure: the object keys, the upload rules and the ownership
// test. The router owns the bytes, the row and the authorization — this file
// owns *where an image goes*, *what is accepted* and *what may be removed*, so
// all three are decided in one place and can be unit-tested without a database
// or a bucket. Same split as `baseNutritionImages.ts` (#715).

import { sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';
import { readPngMetadata, pngSupportsTransparency } from './pngImage';

/**
 * `Exercises/Images` — the leaf of the gym's own folder tree (`GYM_FOLDERS` in
 * `infra/storage.ts`, written at Gym Bucket Initialization) that holds exercise
 * images. #719 §18 fixes it: a gym's upload goes here and never under
 * `cordel/Exercises/Images/`, which stays the platform's.
 */
export const EXERCISE_IMAGES_FOLDER = 'Exercises/Images';

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

/**
 * `<gym prefix>/Exercises/Images/<exercise_id>-<sanitized name>.png` — the key a
 * Gym Exercise's **master** image is stored under (#719 §5).
 *
 * The id leads, so two exercises whose names sanitize alike never share an
 * object, and the `.png` is part of the fixed name rather than a claim about the
 * bytes: only PNG is accepted, so the two cannot disagree. The uploaded file's
 * own name plays no part in the key (#713's rule).
 */
export function buildGymExerciseImageKey(folderPrefix: string, exerciseId: number | string, name: string): string {
  return `${folderPrefix}/${EXERCISE_IMAGES_FOLDER}/${exerciseId}-${sanitizeExerciseImageName(name)}.png`;
}

/** The same key with `-thumbnail` before the extension — the 512×512 companion (#719 §5). */
export function buildGymExerciseImageThumbnailKey(folderPrefix: string, exerciseId: number | string, name: string): string {
  return `${folderPrefix}/${EXERCISE_IMAGES_FOLDER}/${exerciseId}-${sanitizeExerciseImageName(name)}-thumbnail.png`;
}

/**
 * Every folder marker between the bucket root and the gym's
 * `Exercises/Images/`, outermost first. Gym Bucket Initialization already writes
 * these (#417), so this is belt-and-braces for a gym whose tree predates a
 * folder or was initialized against a different bucket — R2 has no directories,
 * so a marker is just a zero-byte `…/` object and rewriting one is a no-op.
 */
export function gymExerciseImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/Exercises/`, `${folderPrefix}/${EXERCISE_IMAGES_FOLDER}/`];
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
 *  - `…/gyms/<this gym>/Exercises/Images/…` → true, the gym's own upload,
 *    including the `<uuid>.png` shape `POST /storage/uploads/exercise-image`
 *    (#417) has always written.
 *  - `…/cordel/Exercises/Images/…` → **false**: platform media, which a gym
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

// ─── Upload rules (#719 §5, §21) ──────────────────────────────────────────────

/** PNG only: the keys are named `.png` and §5 fixes the format. */
export const EXERCISE_IMAGE_MIME = 'image/png';

/** 2048 × 2048, square — the master size §5 specifies, enforced from the IHDR. */
export const EXERCISE_IMAGE_MASTER_SIZE = 2048;

/** 512 × 512 — the thumbnail §5 specifies, the size every list row renders (§15, §17). */
export const EXERCISE_IMAGE_THUMBNAIL_SIZE = 512;

/**
 * 8 MB for the master and 2 MB for the thumbnail. Both are buffered in the API
 * process, so the ceilings exist to bound that rather than to be tight: a
 * 2048×2048 transparent PNG of one exercise is a few hundred KB.
 */
export const EXERCISE_IMAGE_MASTER_MAX_BYTES = 8 * 1024 * 1024;
export const EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Which of the two files a rejection is about, so the message can name it. */
export type ExerciseImageKind = 'image' | 'thumbnail';

/** Why an upload was refused — the router maps each to a status and a message. */
export type ExerciseImageRejection =
  | 'not_a_png'
  | 'wrong_size'
  | 'not_transparent'
  | 'too_large';

export interface ExerciseImageProblem {
  kind: ExerciseImageKind;
  rejection: ExerciseImageRejection;
  message: string;
}

const EXPECTED_SIZE: Record<ExerciseImageKind, number> = {
  image: EXERCISE_IMAGE_MASTER_SIZE,
  thumbnail: EXERCISE_IMAGE_THUMBNAIL_SIZE,
};

const MAX_BYTES: Record<ExerciseImageKind, number> = {
  image: EXERCISE_IMAGE_MASTER_MAX_BYTES,
  thumbnail: EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES,
};

const LABEL: Record<ExerciseImageKind, string> = {
  image: 'Image',
  thumbnail: 'Thumbnail',
};

/**
 * Whether these bytes may be stored as an exercise image of the given kind, and
 * if not, why.
 *
 * Validated from the file, never from the request: the `Content-Type` header and
 * the file name are both the client's word, and #719 §7/§21 require the server
 * to check independently of the browser — which matters twice over here, because
 * the thumbnail is produced *by* the browser (the answer on #719 Q2) and is
 * therefore no more trustworthy than the master.
 *
 * A rejection means nothing is uploaded and nothing is written, so the existing
 * image stays exactly as it was (§8: an invalid upload never replaces valid
 * media).
 */
export function validateExerciseImage(body: unknown, kind: ExerciseImageKind): ExerciseImageProblem | null {
  const problem = (rejection: ExerciseImageRejection, message: string): ExerciseImageProblem => ({ kind, rejection, message });

  // A string and an array both carry a `length` and numeric indices, so either
  // would flow into the size check as if it were bytes (CodeQL
  // `js/type-confusion-through-parameter-tampering`).
  if (!Buffer.isBuffer(body)) return problem('not_a_png', `${LABEL[kind]} must be a PNG file`);
  if (body.length > MAX_BYTES[kind]) {
    return problem('too_large', `${LABEL[kind]} exceeds the ${MAX_BYTES[kind] / (1024 * 1024)} MB limit`);
  }
  const metadata = readPngMetadata(body);
  if (!metadata) return problem('not_a_png', `${LABEL[kind]} must be a PNG file`);
  const size = EXPECTED_SIZE[kind];
  if (metadata.width !== size || metadata.height !== size) {
    return problem('wrong_size', `${LABEL[kind]} must be exactly ${size}×${size} pixels`);
  }
  if (!pngSupportsTransparency(metadata)) {
    return problem('not_transparent', `${LABEL[kind]} must have a transparent background (an alpha channel)`);
  }
  return null;
}

/**
 * Validates the pair an upload carries. The master is checked first so the
 * clearer error wins when the browser produced a bad thumbnail from a bad
 * master, and **both** must pass before anything is uploaded — the answer on
 * #719 Q2 is explicit that a failed thumbnail fails the whole upload rather than
 * storing a master without one.
 */
export function validateExerciseImagePair(image: unknown, thumbnail: unknown): ExerciseImageProblem | null {
  return validateExerciseImage(image, 'image') ?? validateExerciseImage(thumbnail, 'thumbnail');
}

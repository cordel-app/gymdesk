// Where a **Personal Goal**'s image lives, what counts as a valid one, and
// which objects each side is allowed to delete (#1035 stage 2, §4/§5).
//
// Everything here is pure: the two object keys, the folder markers, the upload
// rules and the two ownership tests. The routers own the bytes, the row and the
// authorization — this file owns *where an image goes*, *what is accepted* and
// *what may be removed*, so all three are decided in one place and can be
// unit-tested without a database or a bucket. Same split as
// `baseNutritionImages.ts` (#715) and `exerciseImages.ts` (#719).
//
// **One module for both roots**, unlike exercises, which have one per side
// (`exerciseImages.ts` + `baseExerciseImages.ts`). The reason is that a Personal
// Goal is *one table* holding both kinds of row — `gym_id IS NULL` is a System
// goal and a set `gym_id` is that gym's own (migration 206) — so "which root"
// is a property of the row rather than of the router, and splitting it in two
// would mean two modules reading the same column to answer the same question.
// The keys are still each other's strangers: a gym operation can only ever reach
// `<gym prefix>/goals/` and a platform one only `cordel/goals/`, which is what
// the two ownership predicates below enforce.

import {
  GOALS_FOLDER,
  PLATFORM_STORAGE_ROOT,
  sanitizeStorageObjectName,
  storageKeyFromObjectUrl,
} from '../infra/storage';
import { readPngMetadata } from './pngImage';

/**
 * `goals` — the folder both roots keep a Personal Goal's image in. Re-exported
 * from `infra/storage.ts` rather than spelled again, because the same string is
 * also one of the gym's first-level folder markers: a second literal would be a
 * second spelling waiting to diverge in case, and in R2 a case difference is a
 * different key (#829's rule).
 */
export { GOALS_FOLDER };

/** `cordel/goals`: the one folder every System goal's image is stored in. */
export const PLATFORM_GOALS_PREFIX = `${PLATFORM_STORAGE_ROOT}/${GOALS_FOLDER}`;

/**
 * How much of the goal name a key may carry — the cap
 * `sanitizeExerciseImageName()` applies, for the same reason: `personal_goals.name`
 * is VARCHAR(255) and a gym's folder prefix is itself built from a VARCHAR(255)
 * gym name, so an uncapped key can outgrow the VARCHAR(1024) column that stores
 * the resulting URL — and the row is written *after* the object is in R2, so the
 * overflow would leave an orphan and a 500 rather than a clean rejection. The id
 * in front of the name is what keeps two long names that truncate alike from
 * sharing an object.
 */
const MAX_KEY_NAME_CHARS = 80;

/**
 * A goal name as it appears in an object key: `Weight Loss` → `Weight-Loss`,
 * `Pérdida de peso` → `Perdida-de-peso`.
 *
 * {@link sanitizeStorageObjectName} is the rule (one sanitizer for the whole
 * tree, #1035 §12 — "do not introduce a new sanitization algorithm"); only the
 * fallback word is this feature's, so a name of nothing but punctuation can
 * never produce `goals/12-.png`.
 */
export function sanitizePersonalGoalImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'goal').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/**
 * `<gym prefix>/goals/<goal_id>-<sanitized name>.png` — the key a **gym's own**
 * Personal Goal image is stored under, exactly as the ticket's tree spells it.
 *
 * Deterministic: the same goal always produces the same key, so replacing an
 * image overwrites its own object instead of orphaning one, and the stale-object
 * sweep only has work to do when the key genuinely moved (the goal was renamed,
 * or its image predates this shape). The `.png` is part of the fixed name rather
 * than a claim about the bytes — only PNG is accepted, so the two cannot
 * disagree — and the uploaded file's own name plays no part in the key (#713).
 */
export function buildGymPersonalGoalImageKey(
  folderPrefix: string,
  goalId: number | string,
  name: string,
): string {
  return `${folderPrefix}/${GOALS_FOLDER}/${goalId}-${sanitizePersonalGoalImageName(name)}.png`;
}

/**
 * `cordel/goals/<goal_id>-<sanitized name>.png` — the same key one root over,
 * for a **System** goal (`gym_id IS NULL`), which belongs to no gym and so has
 * no `gyms.storage_folder_prefix` to hang off (#732's reasoning,
 * `baseNutritionImages.ts`' shape).
 */
export function buildBasePersonalGoalImageKey(goalId: number | string, name: string): string {
  return `${PLATFORM_GOALS_PREFIX}/${goalId}-${sanitizePersonalGoalImageName(name)}.png`;
}

/**
 * Every folder marker between the bucket root and the gym's `goals/`, outermost
 * first. Gym Bucket Initialization writes these (`GYM_FOLDERS`), so this is
 * belt-and-braces for a gym whose tree predates the folder or was initialized
 * against a different bucket — R2 has no directories, so a marker is a
 * zero-byte `…/` object and rewriting one is a no-op.
 */
export function gymPersonalGoalImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${GOALS_FOLDER}/`];
}

/**
 * The same, under the platform root. Gym Bucket Initialization deliberately
 * writes **nothing** under `cordel/` (#1035 §2/§7, confirmed by `Q5`), so the
 * first upload is what makes the branch visible in a bucket browser.
 */
export function basePersonalGoalImageFolderKeys(): string[] {
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_GOALS_PREFIX}/`];
}

// ─── Ownership ────────────────────────────────────────────────────────────────

/**
 * Whether the object behind `url` is one **this gym** owns, and may therefore
 * delete when its goal's image is replaced or removed.
 *
 * The `isGymOwnedImageUrl()` rule (#719 §19) applied to this feature: true only
 * for a URL this deployment built (`storageKeyFromObjectUrl()` — a different
 * endpoint or bucket is already "not ours") whose key sits under the gym's own
 * prefix. So `…/gyms/<this gym>/goals/…` is true, `…/cordel/goals/…` is
 * **false** (a System object, which a gym operation must never delete), another
 * gym's folder is false, and a hand-typed external URL is false because there is
 * no object of ours behind it.
 *
 * The comparison is anchored with a trailing `/` so `gyms/<id>-Fit` can never
 * match `gyms/<other id>-FitnessPlus`.
 */
export function isGymOwnedPersonalGoalImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/`);
}

/**
 * The mirror image: whether the object behind `url` is the **platform's** own,
 * and may therefore be deleted when a System goal's image moves.
 *
 * Narrowed to `cordel/goals/` rather than to `cordel/`, exactly as
 * `isPlatformOwnedExerciseImageUrl()` is: another feature's object is not this
 * one's to delete either, however platform-owned it is.
 */
export function isPlatformOwnedPersonalGoalImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${PLATFORM_GOALS_PREFIX}/`);
}

// ─── Upload rules (#1035 §4, `Q3`) ────────────────────────────────────────────

/** PNG only: the key is named `.png` and the ticket's tree fixes the format. */
export const PERSONAL_GOAL_IMAGE_MIME = 'image/png';

/**
 * **At most** 512 × 512 — `Q3`'s answer in as many words ("Same, with a maximum
 * of 512×512 px but no need to alpha"), which is deliberately *not* the exact
 * square a Base Nutrition Library food is held to (#715 §2).
 *
 * So neither dimension may exceed this, and a smaller or non-square image is
 * accepted: the frames that draw it are 1:1 with `object-fit: contain`, so a
 * 400×300 icon reads correctly, and refusing it would be a rule the answer did
 * not ask for. The ceiling is what the rule is about — a 4000px photograph in a
 * 512px slot is the mistake worth catching.
 */
export const PERSONAL_GOAL_IMAGE_MAX_SIZE = 512;

/**
 * 2 MB, the Base Nutrition Library's ceiling for an image of the same size. The
 * bytes are buffered in the API process (`express.raw`), so the limit exists to
 * bound that rather than to be tight.
 */
export const PERSONAL_GOAL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Why an upload was refused — the router maps each to a status and a message. */
export type PersonalGoalImageRejection = 'not_a_png' | 'too_large_dimensions';

/**
 * Whether these bytes may become a Personal Goal's image, and if not, why.
 *
 * Validated from the **file**, never from the request: the `Content-Type` header
 * and the file name are both the client's word (#715 §8, #719 §7), so the PNG
 * signature and the dimensions are read out of the bytes themselves. A rejection
 * means nothing is uploaded and nothing is written, so the image already on the
 * goal stays exactly as it was.
 *
 * There is deliberately **no transparency check**: `Q3` drops the alpha
 * requirement a Base Nutrition food carries, so an opaque PNG is a legitimate
 * goal image and `pngSupportsTransparency()` is not asked.
 */
export function validatePersonalGoalImage(body: unknown): PersonalGoalImageRejection | null {
  const metadata = readPngMetadata(body);
  if (!metadata) return 'not_a_png';
  if (
    metadata.width > PERSONAL_GOAL_IMAGE_MAX_SIZE
    || metadata.height > PERSONAL_GOAL_IMAGE_MAX_SIZE
  ) {
    return 'too_large_dimensions';
  }
  return null;
}

/** Human-readable reason for each rejection, as the API returns it. */
export const PERSONAL_GOAL_IMAGE_REJECTION_MESSAGES: Record<PersonalGoalImageRejection, string> = {
  not_a_png: 'Image must be a PNG file',
  too_large_dimensions:
    `Image must be at most ${PERSONAL_GOAL_IMAGE_MAX_SIZE}×${PERSONAL_GOAL_IMAGE_MAX_SIZE} pixels`,
};

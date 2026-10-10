// Where a **Member**'s profile image lives, what counts as a valid one, and
// which objects a gym may delete (#1374).
//
// Everything here is pure: the object key, the folder markers, the upload rules
// and the ownership test. The router owns the bytes, the row and the
// authorization — this file owns *where an image goes*, *what is accepted* and
// *what may be removed*, so all three are decided in one place and can be
// unit-tested without a database or a bucket. Same split as
// `personalGoalImages.ts` (#1035), `baseNutritionImages.ts` (#715) and
// `exerciseImages.ts` (#719).
//
// One root only: a Member belongs to one gym, so unlike a Personal Goal there is
// no platform-owned row and no `cordel/members/` — a gym operation can only ever
// reach `<gym prefix>/members/`, which the ownership predicate enforces.

import { MEMBERS_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';
import { readPngMetadata } from './pngImage';

/**
 * `members` — re-exported from `infra/storage.ts` rather than spelled again,
 * because the same string is one of the gym's first-level folder markers: a
 * second literal would be a second spelling waiting to diverge in case, and in
 * R2 a case difference is a different key (#829's rule).
 */
export { MEMBERS_FOLDER };

/**
 * How much of the member's name a key may carry — the cap
 * `sanitizePersonalGoalImageName()` applies, for the same reason: `members.name`
 * is VARCHAR(255) and the gym's folder prefix is itself built from a VARCHAR(255)
 * gym name, so an uncapped key can outgrow the VARCHAR(1024) column that stores
 * the URL, and the row is written *after* the object is in R2. The id in front
 * of the name is what keeps two long names that truncate alike from sharing an
 * object.
 */
const MAX_KEY_NAME_CHARS = 80;

/**
 * A member's name as it appears in an object key: `María José Pérez` →
 * `Maria-Jose-Perez`. {@link sanitizeStorageObjectName} is the rule (one
 * sanitizer for the whole tree, #1035 §12); only the fallback word is this
 * feature's, so a name of nothing but punctuation never produces `members/12-.png`.
 */
export function sanitizeMemberImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'member').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/**
 * `<gym prefix>/members/<member_id>-<sanitized name>.png` — the key a Member's
 * profile image is stored under, exactly as `docs/cloudflare_structure.md`
 * spells it.
 *
 * Deterministic: the same member always produces the same key, so replacing an
 * image overwrites its own object instead of orphaning one, and an object only
 * moves when the key genuinely changes — the member was renamed (which
 * `PUT /members/:id` handles by copying it) or the image predates this shape.
 * The `.png` is part of the fixed name rather than a claim about the bytes —
 * only PNG is accepted, so the two cannot disagree — and the uploaded file's own
 * name plays no part in the key (#713).
 */
export function buildMemberImageKey(
  folderPrefix: string,
  memberId: number | string,
  name: string,
): string {
  return `${folderPrefix}/${MEMBERS_FOLDER}/${memberId}-${sanitizeMemberImageName(name)}.png`;
}

/**
 * Every folder marker between the bucket root and the gym's `members/`,
 * outermost first. Gym Bucket Initialization writes these (`GYM_FOLDERS`), so
 * this is belt-and-braces for a gym whose tree predates the folder — R2 has no
 * directories, so a marker is a zero-byte `…/` object and rewriting one is a
 * no-op.
 */
export function memberImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${MEMBERS_FOLDER}/`];
}

// ─── Ownership ────────────────────────────────────────────────────────────────

/**
 * Whether the object behind `url` is one **this gym** owns under `members/`,
 * and may therefore delete when the member's image is replaced, moved or
 * removed.
 *
 * The `isGymOwnedImageUrl()` rule (#719 §19), narrowed to this feature's own
 * branch exactly as `isPlatformOwnedExerciseImageUrl()` is: true only for a URL
 * this deployment built (`storageKeyFromObjectUrl()` — a different endpoint or
 * bucket is already "not ours") whose key sits under `<prefix>/members/`. So
 * another gym's folder is false, `cordel/…` is false, a gym's own `goals/`
 * object is false (another feature's object is not this one's to delete), and a
 * hand-typed external URL is false because there is no object of ours behind it.
 *
 * Anchored with a trailing `/` so `gyms/<id>-Fit` can never match
 * `gyms/<other id>-FitnessPlus`.
 */
export function isGymOwnedMemberImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${MEMBERS_FOLDER}/`);
}

// ─── Upload rules (#1374 §1/§3) ───────────────────────────────────────────────

/** PNG only: the key is named `.png` and the ticket's tree fixes the format. */
export const MEMBER_IMAGE_MIME = 'image/png';

/**
 * **Exactly** 512 × 512 — the ticket's convention ("Image dimensions: 512 × 512
 * pixels", "the final stored image must comply"). Deliberately stricter than a
 * Personal Goal's *at most* 512 (#1035 `Q3`): a profile image is drawn in a
 * fixed square on every surface, and the admin crops and scales whatever staff
 * pick before uploading, so an off-size file here is a client that skipped that
 * step rather than a legitimate smaller icon.
 */
export const MEMBER_IMAGE_SIZE = 512;

/**
 * 2 MB, the Personal Goal's ceiling for an image of the same size. The bytes are
 * buffered in the API process (`express.raw`), so the limit exists to bound that
 * rather than to be tight — a 512 × 512 PNG photograph is well under 1 MB.
 */
export const MEMBER_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Why an upload was refused — the router maps each to a status and a message. */
export type MemberImageRejection = 'not_a_png' | 'wrong_dimensions';

/**
 * Whether these bytes may become a Member's profile image, and if not, why.
 *
 * Validated from the **file**, never from the request: the `Content-Type`
 * header and the file name are both the client's word (#715 §8, #719 §7), so
 * the PNG signature and the dimensions are read out of the bytes themselves. A
 * rejection means nothing is uploaded and nothing is written, so the image
 * already on the member stays exactly as it was.
 *
 * No transparency check: a photograph is opaque, so `pngSupportsTransparency()`
 * is not asked (the #1035 `Q3` rule, which fits a face even better than a goal
 * icon).
 */
export function validateMemberImage(body: unknown): MemberImageRejection | null {
  const metadata = readPngMetadata(body);
  if (!metadata) return 'not_a_png';
  if (metadata.width !== MEMBER_IMAGE_SIZE || metadata.height !== MEMBER_IMAGE_SIZE) {
    return 'wrong_dimensions';
  }
  return null;
}

/** Human-readable reason for each rejection, as the API returns it. */
export const MEMBER_IMAGE_REJECTION_MESSAGES: Record<MemberImageRejection, string> = {
  not_a_png: 'Image must be a PNG file',
  wrong_dimensions: `Image must be exactly ${MEMBER_IMAGE_SIZE}×${MEMBER_IMAGE_SIZE} pixels`,
};

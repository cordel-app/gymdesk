// Where a **Member**'s profile image lives, what counts as a valid one, and
// which objects a gym may delete (#1374, reshaped by #1449: a WebP master and a
// WebP thumbnail, both made by the server from one uploaded original).
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
import { positiveInteger } from './internalRunRateLimit';

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
 * `<gym prefix>/members/<member_id>-<sanitized name>.webp` — the key a Member's
 * 1080 × 1080 profile image is stored under, exactly as
 * `docs/cloudflare_structure.md` spells it.
 *
 * Deterministic: the same member always produces the same key, so replacing an
 * image overwrites its own object instead of orphaning one, and an object only
 * moves when the key genuinely changes — the member was renamed (which
 * `PUT /members/:id` handles by copying it) or the image predates this shape.
 * The `.webp` is part of the fixed name because the server always encodes
 * WebP, whatever the uploaded original was, and the uploaded file's own name
 * plays no part in the key (#713).
 */
export function buildMemberImageKey(
  folderPrefix: string,
  memberId: number | string,
  name: string,
): string {
  return `${folderPrefix}/${MEMBERS_FOLDER}/${memberId}-${sanitizeMemberImageName(name)}.webp`;
}

/** `<gym prefix>/members/<member_id>-<sanitized name>-thumbnail.webp` — the 256 × 256 sibling. */
export function buildMemberImageThumbnailKey(
  folderPrefix: string,
  memberId: number | string,
  name: string,
): string {
  return `${folderPrefix}/${MEMBERS_FOLDER}/${memberId}-${sanitizeMemberImageName(name)}-thumbnail.webp`;
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

// ─── Upload rules (#1449) ─────────────────────────────────────────────────────

/** The two stored sizes, square — what the server makes, never what a client sends. */
export const MEMBER_IMAGE_SIZE = 1080;
export const MEMBER_IMAGE_THUMBNAIL_SIZE = 256;

/** What the server stores both files as. */
export const MEMBER_IMAGE_STORED_MIME = 'image/webp';

/**
 * What a client may *send*: the formats a phone or a website produces. Judged
 * from the decoded bytes (`memberImageProcessing.ts`), never from the declared
 * `Content-Type` or the file name — the type below is only the request's
 * envelope (`image/*`), and a HEIC is not decoded (iOS hands the web view a JPEG
 * for `accept="image/*"`).
 */
export const MEMBER_IMAGE_INPUT_FORMATS = ['jpeg', 'png', 'webp', 'gif'] as const;

/** Largest picture, in pixels, the server will decode (a 50-megapixel camera). */
export const MEMBER_IMAGE_MAX_PIXELS = 50_000_000;

const DEFAULT_MAX_MB = 10;
const CEILING_MAX_MB = 25;

/**
 * The upload ceiling in bytes: `MEMBER_IMAGE_MAX_MB` (megabytes), default 10,
 * never above 25 — `EXERCISE_VIDEO_MAX_MB`'s shape. The upload is buffered in the
 * API process, so this is what bounds that memory, and the browser checks the
 * same number so an oversized file is refused before it is sent.
 */
export function memberImageMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MEMBER_IMAGE_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? Math.min(raw, CEILING_MAX_MB) : DEFAULT_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** What `MEMBER_IMAGE_UPLOAD_RATE_LIMIT_MAX` defaults to when nothing valid is set. */
export const MEMBER_IMAGE_UPLOAD_RATE_LIMIT_DEFAULT_MAX = 30;

/** The window the upload limit is counted over, in milliseconds. */
export const MEMBER_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Photo uploads one signed-in person may make per window, on top of the global
 * budget (`API_RATE_LIMIT_MAX`, #1395). A photo upload is the one cheap-looking
 * request that is not cheap: the server decodes up to `MEMBER_IMAGE_MAX_MB` of
 * picture and encodes two WebP files, so a loop of uploads costs far more CPU
 * than the same number of reads. Thirty is generous for a person replacing their
 * photo and for a front desk adding members with pictures, and refuses a script.
 */
export function memberImageUploadRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.MEMBER_IMAGE_UPLOAD_RATE_LIMIT_MAX, MEMBER_IMAGE_UPLOAD_RATE_LIMIT_DEFAULT_MAX);
}

/** Why an upload was refused — the router maps each to a status and a message. */
export type MemberImageRejection = 'unreadable' | 'unsupported_format' | 'too_many_pixels';

/** Human-readable reason for each rejection, as the API returns it. */
export const MEMBER_IMAGE_REJECTION_MESSAGES: Record<MemberImageRejection, string> = {
  unreadable: 'The file could not be read as an image',
  unsupported_format: 'Image must be a JPEG, PNG, WebP or GIF file',
  too_many_pixels: `Image is too large: at most ${MEMBER_IMAGE_MAX_PIXELS / 1_000_000} megapixels`,
};

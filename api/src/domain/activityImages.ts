// Where an **Activity Type**'s image lives, what counts as a valid one, and
// which objects a gym may delete (#1373). Pure, like `memberImages.ts` (#1374),
// whose shape this is one table over: the router owns the bytes, the row and the
// authorization; this file owns *where an image goes*, *what is accepted* and
// *what may be removed*.
//
// One root only: an Activity Type belongs to one gym, so there is no
// `cordel/activities/`.

import { ACTIVITIES_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';
import { readPngMetadata } from './pngImage';

export { ACTIVITIES_FOLDER };

/** Same cap and reason as `sanitizeMemberImageName()`: the URL column is VARCHAR(1024). */
const MAX_KEY_NAME_CHARS = 80;

export function sanitizeActivityImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'activity').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/**
 * `<gym prefix>/activities/<activity_id>-<sanitized name>.png`, exactly as
 * `docs/cloudflare_structure.md` spells it. Deterministic, so replacing an image
 * overwrites its own object and an object only moves when the activity is renamed.
 */
export function buildActivityImageKey(folderPrefix: string, activityId: number | string, name: string): string {
  return `${folderPrefix}/${ACTIVITIES_FOLDER}/${activityId}-${sanitizeActivityImageName(name)}.png`;
}

export function activityImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${ACTIVITIES_FOLDER}/`];
}

/** Whether the object behind `url` is one **this gym** owns under `activities/`. */
export function isGymOwnedActivityImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${ACTIVITIES_FOLDER}/`);
}

export const ACTIVITY_IMAGE_MIME = 'image/png';

/** Exactly 1080 × 1080 (the ticket's size); the admin crops and scales before uploading. */
export const ACTIVITY_IMAGE_SIZE = 1080;

/** A 1080 × 1080 PNG photograph is a few MB; the limit only bounds the buffered body. */
export const ACTIVITY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export type ActivityImageRejection = 'not_a_png' | 'wrong_dimensions';

/** Validated from the bytes, never from the `Content-Type` or the file name. No alpha requirement. */
export function validateActivityImage(body: unknown): ActivityImageRejection | null {
  const metadata = readPngMetadata(body);
  if (!metadata) return 'not_a_png';
  if (metadata.width !== ACTIVITY_IMAGE_SIZE || metadata.height !== ACTIVITY_IMAGE_SIZE) {
    return 'wrong_dimensions';
  }
  return null;
}

export const ACTIVITY_IMAGE_REJECTION_MESSAGES: Record<ActivityImageRejection, string> = {
  not_a_png: 'Image must be a PNG file',
  wrong_dimensions: `Image must be exactly ${ACTIVITY_IMAGE_SIZE}×${ACTIVITY_IMAGE_SIZE} pixels`,
};

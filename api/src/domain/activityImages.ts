// Where an **Activity Type**'s image lives, what counts as a valid one, and
// which objects a gym may delete (#1373). Pure, like `memberImages.ts` (#1374),
// whose shape this is one table over: the router owns the bytes, the row and the
// authorization; this file owns *where an image goes*, *what is accepted* and
// *what may be removed*.
//
// One root only: an Activity Type belongs to one gym, so there is no
// `cordel/activities/`.

import { ACTIVITIES_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { ACTIVITIES_FOLDER };

/** Same cap and reason as `sanitizeMemberImageName()`: the URL column is VARCHAR(1024). */
const MAX_KEY_NAME_CHARS = 80;

export function sanitizeActivityImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'activity').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/**
 * `<gym prefix>/activities/<activity_id>-<sanitized name>.webp` — the 1080 × 1080
 * master the server makes from the uploaded original (#1714, the Member photo's
 * pipeline). Deterministic, so replacing an image overwrites its own object and an
 * object only moves when the activity is renamed. A pre-#1714 row keeps its `.png`.
 */
export function buildActivityImageKey(folderPrefix: string, activityId: number | string, name: string): string {
  return `${folderPrefix}/${ACTIVITIES_FOLDER}/${activityId}-${sanitizeActivityImageName(name)}.webp`;
}

/** The 256 × 256 sibling: `…-thumbnail.webp`. Never stored — derived from the master's URL/key. */
export function buildActivityImageThumbnailKey(folderPrefix: string, activityId: number | string, name: string): string {
  return `${folderPrefix}/${ACTIVITIES_FOLDER}/${activityId}-${sanitizeActivityImageName(name)}-thumbnail.webp`;
}

/** The thumbnail's URL for a stored master URL, or null for a legacy (non-WebP) master that has none. */
export function activityImageThumbnailUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl || !/\.webp(\?.*)?$/i.test(imageUrl)) return null;
  return imageUrl.replace(/\.webp(\?.*)?$/i, '-thumbnail.webp$1');
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

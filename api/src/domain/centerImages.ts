// Where a **Center**'s image lives and which objects may be deleted (#2261).
// The pipeline is the Professional Service's (#2010), the Product's (#1715) and
// the Member photo's (#1449): a WebP master and a WebP thumbnail the server makes
// from one uploaded original, so request judgement, processing and upload limits
// are `memberImages.ts`' and `memberImageProcessing.ts`'. This file owns only
// *where a Center's image goes* and *what may be removed*. Pure.
//
// `<gym storage_folder_prefix>/centers/<id>-<name>.webp` and `…-thumbnail.webp`.

import { CENTERS_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { CENTERS_FOLDER };

const MAX_KEY_NAME_CHARS = 80;

/** A Center's name as it appears in an object key: `Main Gym` → `Main-Gym`. */
export function sanitizeCenterImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'center').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<prefix>/centers/<id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildCenterImageKey(prefix: string, centerId: number | string, name: string): string {
  return `${prefix}/${CENTERS_FOLDER}/${centerId}-${sanitizeCenterImageName(name)}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildCenterImageThumbnailKey(prefix: string, centerId: number | string, name: string): string {
  return `${prefix}/${CENTERS_FOLDER}/${centerId}-${sanitizeCenterImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `centers/`, outermost first. */
export function centerImageFolderKeys(prefix: string): string[] {
  return [`${prefix}/`, `${prefix}/${CENTERS_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **under `prefix`'s `centers/`** and so
 * may be deleted when a Center's image is replaced, moved or removed (#719 §19
 * narrowed to this feature): another gym's folder, another feature's object and
 * an external URL are all false.
 */
export function isOwnedCenterImageUrl(url: string | null | undefined, prefix: string | null | undefined): boolean {
  if (!url || !prefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${prefix}/${CENTERS_FOLDER}/`);
}

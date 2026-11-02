// Where a **Staff**'s image lives and which objects may be deleted (#2262).
// The pipeline is the Professional Service's (#2010), the Product's (#1715) and
// the Member photo's (#1449): a WebP master and a WebP thumbnail the server makes
// from one uploaded original, so request judgement, processing and upload limits
// are `memberImages.ts`' and `memberImageProcessing.ts`'. This file owns only
// *where a Staff's image goes* and *what may be removed*. Pure.
//
// `<gym storage_folder_prefix>/staff/<id>-<name>.webp` and `…-thumbnail.webp`.

import { STAFF_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { STAFF_FOLDER };

const MAX_KEY_NAME_CHARS = 80;

/** A Staff's name as it appears in an object key: `Ana Lopez` → `Ana-Lopez`. */
export function sanitizeStaffImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'staff').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<prefix>/staff/<id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildStaffImageKey(prefix: string, staffId: number | string, name: string): string {
  return `${prefix}/${STAFF_FOLDER}/${staffId}-${sanitizeStaffImageName(name)}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildStaffImageThumbnailKey(prefix: string, staffId: number | string, name: string): string {
  return `${prefix}/${STAFF_FOLDER}/${staffId}-${sanitizeStaffImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `staff/`, outermost first. */
export function staffImageFolderKeys(prefix: string): string[] {
  return [`${prefix}/`, `${prefix}/${STAFF_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **under `prefix`'s `staff/`** and so
 * may be deleted when a Staff's image is replaced, moved or removed (#719 §19
 * narrowed to this feature): another gym's folder, another feature's object and
 * an external URL are all false.
 */
export function isOwnedStaffImageUrl(url: string | null | undefined, prefix: string | null | undefined): boolean {
  if (!url || !prefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${prefix}/${STAFF_FOLDER}/`);
}

/** The name an object key is built from: the Staff member's full name. */
export function staffImageName(staff: { first_name: string; last_name: string }): string {
  return `${staff.first_name} ${staff.last_name}`.trim();
}

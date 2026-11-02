// Where a **Space**'s image lives and which objects may be deleted (#2260).
// The pipeline is the Professional Service's (#2010), the Product's (#1715) and
// the Member photo's (#1449): a WebP master and a WebP thumbnail the server makes
// from one uploaded original, so request judgement, processing and upload limits
// are `memberImages.ts`' and `memberImageProcessing.ts`'. This file owns only
// *where a Space's image goes* and *what may be removed*. Pure.
//
// `<gym storage_folder_prefix>/spaces/<id>-<name>.webp` and `…-thumbnail.webp`.

import { SPACES_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { SPACES_FOLDER };

const MAX_KEY_NAME_CHARS = 80;

/** A Space's name as it appears in an object key: `Main Gym` → `Main-Gym`. */
export function sanitizeSpaceImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'space').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<prefix>/spaces/<id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildSpaceImageKey(prefix: string, spaceId: number | string, name: string): string {
  return `${prefix}/${SPACES_FOLDER}/${spaceId}-${sanitizeSpaceImageName(name)}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildSpaceImageThumbnailKey(prefix: string, spaceId: number | string, name: string): string {
  return `${prefix}/${SPACES_FOLDER}/${spaceId}-${sanitizeSpaceImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `spaces/`, outermost first. */
export function spaceImageFolderKeys(prefix: string): string[] {
  return [`${prefix}/`, `${prefix}/${SPACES_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **under `prefix`'s `spaces/`** and so
 * may be deleted when a Space's image is replaced, moved or removed (#719 §19
 * narrowed to this feature): another gym's folder, another feature's object and
 * an external URL are all false.
 */
export function isOwnedSpaceImageUrl(url: string | null | undefined, prefix: string | null | undefined): boolean {
  if (!url || !prefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${prefix}/${SPACES_FOLDER}/`);
}

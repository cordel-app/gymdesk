// Where a **Base Product**'s image lives and which objects may be deleted
// (#2009 stage 3). The pipeline is the Product's (#1715) and the Member photo's
// (#1449) — a WebP master and a WebP thumbnail the server makes from one
// uploaded original — so request judgement, processing and upload limits are
// `memberImages.ts`' and `memberImageProcessing.ts`'; this file owns only *where
// a template's image goes* and *what may be removed*. Pure: no database, no bucket.
//
// `cordel/base_products/<id>-<name>.webp`. A gym's imported Product inherits the
// image *URLs* (stage 2), so the object is shared with rows this module never
// sees; the caller checks `products` as well as `base_products` before deleting.

import {
  BASE_PRODUCTS_FOLDER, PLATFORM_STORAGE_ROOT, sanitizeStorageObjectName, storageKeyFromObjectUrl,
} from '../infra/storage';

export { BASE_PRODUCTS_FOLDER };

/** Same cap as a member's name in a key, for the same VARCHAR(1024) reason. */
const MAX_KEY_NAME_CHARS = 80;

/** A template's name as it appears in an object key: `Locker Rental` → `Locker-Rental`. */
export function sanitizeBaseProductImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'product').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `cordel/base_products/<id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildBaseProductImageKey(id: number | string, name: string, variant?: string): string {
  return `${PLATFORM_STORAGE_ROOT}/${BASE_PRODUCTS_FOLDER}/${id}-${sanitizeBaseProductImageName(name)}${variant ? `-${variant}` : ''}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildBaseProductImageThumbnailKey(id: number | string, name: string, variant?: string): string {
  return `${PLATFORM_STORAGE_ROOT}/${BASE_PRODUCTS_FOLDER}/${id}-${sanitizeBaseProductImageName(name)}${variant ? `-${variant}` : ''}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `base_products/`, outermost first. */
export function baseProductImageFolderKeys(): string[] {
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_STORAGE_ROOT}/${BASE_PRODUCTS_FOLDER}/`];
}

/** Whether the object behind `url` is one under `cordel/base_products/` — the only objects this feature may delete. */
export function isBaseProductImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  return !!key && key.startsWith(`${PLATFORM_STORAGE_ROOT}/${BASE_PRODUCTS_FOLDER}/`);
}

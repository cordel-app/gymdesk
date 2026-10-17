// Where a **Product**'s image lives and which objects a gym may delete
// (#1715). The pipeline is the Member photo's (#1449) — a WebP master and a WebP
// thumbnail the server makes from one uploaded original — so the request
// judgement, the processing and the upload limits are `memberImages.ts`' and
// `memberImageProcessing.ts`' and are not restated here; this file owns only
// *where a product's image goes* and *what may be removed*. Pure: no database, no
// bucket.

import { PRODUCTS_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { PRODUCTS_FOLDER };

/** Same cap as a member's name in a key, for the same VARCHAR(1024) reason. */
const MAX_KEY_NAME_CHARS = 80;

/** A product's name as it appears in an object key: `Gold Product 2026` → `Gold-Product-2026`. */
export function sanitizeProductImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'product').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<gym prefix>/products/<product_id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildProductImageKey(folderPrefix: string, productId: number | string, name: string, variant?: string): string {
  return `${folderPrefix}/${PRODUCTS_FOLDER}/${productId}-${sanitizeProductImageName(name)}${variant ? `-${variant}` : ''}.webp`;
}

/** `<gym prefix>/products/<product_id>-<sanitized name>-thumbnail.webp` — the 256 × 256 sibling. */
export function buildProductImageThumbnailKey(folderPrefix: string, productId: number | string, name: string, variant?: string): string {
  return `${folderPrefix}/${PRODUCTS_FOLDER}/${productId}-${sanitizeProductImageName(name)}${variant ? `-${variant}` : ''}-thumbnail.webp`;
}

/** Folder markers between the bucket root and the gym's `products/`, outermost first. */
export function productImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${PRODUCTS_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **this gym** owns under `products/` and
 * may delete when the product's image is replaced, moved or removed (#719 §19's
 * rule narrowed to this feature's branch): another gym's folder, another
 * feature's object and an external URL are all false.
 */
export function isGymOwnedProductImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${PRODUCTS_FOLDER}/`);
}

/**
 * #1715: a Product copied from another inherits its image *URLs*, so one object
 * can be referenced by several rows while its key names only one of them. The
 * key a new upload goes to is the deterministic one unless another row already
 * points at it — then it gets a `variant` (a timestamp), so replacing the source
 * product's image can never overwrite what its copies still show.
 */
export function pickImageVariant(sharedKeyInUse: boolean, now: number = Date.now()): string | undefined {
  return sharedKeyInUse ? String(now) : undefined;
}

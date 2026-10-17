// Where a **Promotion**'s image lives and which objects a gym may delete
// (#1711). The pipeline is the Member photo's (#1449) — a WebP master and a WebP
// thumbnail the server makes from one uploaded original — so the request
// judgement, the processing and the upload limits are `memberImages.ts`' and
// `memberImageProcessing.ts`' and are not restated here; this file owns only
// *where a promotion's image goes* and *what may be removed*. Pure: no database, no
// bucket.

import { PROMOTIONS_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { PROMOTIONS_FOLDER };

/** Same cap as a member's name in a key, for the same VARCHAR(1024) reason. */
const MAX_KEY_NAME_CHARS = 80;

/** A promotion's name as it appears in an object key: `Gold Promotion 2026` → `Gold-Promotion-2026`. */
export function sanitizePromotionImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'promotion').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<gym prefix>/promotions/<promotion_id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildPromotionImageKey(folderPrefix: string, promotionId: number | string, name: string): string {
  return `${folderPrefix}/${PROMOTIONS_FOLDER}/${promotionId}-${sanitizePromotionImageName(name)}.webp`;
}

/** `<gym prefix>/promotions/<promotion_id>-<sanitized name>-thumbnail.webp` — the 256 × 256 sibling. */
export function buildPromotionImageThumbnailKey(folderPrefix: string, promotionId: number | string, name: string): string {
  return `${folderPrefix}/${PROMOTIONS_FOLDER}/${promotionId}-${sanitizePromotionImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and the gym's `promotions/`, outermost first. */
export function promotionImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${PROMOTIONS_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **this gym** owns under `promotions/` and
 * may delete when the promotion's image is replaced, moved or removed (#719 §19's
 * rule narrowed to this feature's branch): another gym's folder, another
 * feature's object and an external URL are all false.
 */
export function isGymOwnedPromotionImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${PROMOTIONS_FOLDER}/`);
}

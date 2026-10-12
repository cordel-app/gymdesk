// Where a **Membership Plan**'s image lives and which objects a gym may delete
// (#1514). The pipeline is the Member photo's (#1449) — a WebP master and a WebP
// thumbnail the server makes from one uploaded original — so the request
// judgement, the processing and the upload limits are `memberImages.ts`' and
// `memberImageProcessing.ts`' and are not restated here; this file owns only
// *where a plan's image goes* and *what may be removed*. Pure: no database, no
// bucket.

import { PLANS_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { PLANS_FOLDER };

/** Same cap as a member's name in a key, for the same VARCHAR(1024) reason. */
const MAX_KEY_NAME_CHARS = 80;

/** A plan's name as it appears in an object key: `Gold Plan 2026` → `Gold-Plan-2026`. */
export function sanitizePlanImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'plan').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<gym prefix>/plans/<plan_id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildPlanImageKey(folderPrefix: string, planId: number | string, name: string): string {
  return `${folderPrefix}/${PLANS_FOLDER}/${planId}-${sanitizePlanImageName(name)}.webp`;
}

/** `<gym prefix>/plans/<plan_id>-<sanitized name>-thumbnail.webp` — the 256 × 256 sibling. */
export function buildPlanImageThumbnailKey(folderPrefix: string, planId: number | string, name: string): string {
  return `${folderPrefix}/${PLANS_FOLDER}/${planId}-${sanitizePlanImageName(name)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and the gym's `plans/`, outermost first. */
export function planImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${PLANS_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **this gym** owns under `plans/` and
 * may delete when the plan's image is replaced, moved or removed (#719 §19's
 * rule narrowed to this feature's branch): another gym's folder, another
 * feature's object and an external URL are all false.
 */
export function isGymOwnedPlanImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${PLANS_FOLDER}/`);
}

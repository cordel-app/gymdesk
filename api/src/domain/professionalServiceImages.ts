// Where a **Professional Service**'s image lives and which objects may be
// deleted (#2010). The pipeline is the Product's (#1715) and the Member photo's
// (#1449) — a WebP master and a WebP thumbnail the server makes from one
// uploaded original — so request judgement, processing and upload limits are
// `memberImages.ts`' and `memberImageProcessing.ts`'; this file owns only *where
// a service's image goes* and *what may be removed*. Pure: no database, no bucket.
//
// One shape for both roots, one root apart: `<prefix>/professional_services/<id>-<name>.webp`
// with the gym's `storage_folder_prefix` for a gym-owned service and `cordel`
// (`PLATFORM_STORAGE_ROOT`) for a Base one.

import { PROFESSIONAL_SERVICES_FOLDER, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

export { PROFESSIONAL_SERVICES_FOLDER };

/** Same cap as a member's name in a key, for the same VARCHAR(1024) reason. */
const MAX_KEY_NAME_CHARS = 80;

/** A service's name as it appears in an object key: `Personal Training` → `Personal-Training`. */
export function sanitizeProfessionalServiceImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'service').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/** `<prefix>/professional_services/<id>-<sanitized name>.webp` — the 1080 × 1080 master. */
export function buildProfessionalServiceImageKey(
  prefix: string, serviceId: number | string, name: string, variant?: string,
): string {
  return `${prefix}/${PROFESSIONAL_SERVICES_FOLDER}/${serviceId}-${sanitizeProfessionalServiceImageName(name)}${variant ? `-${variant}` : ''}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildProfessionalServiceImageThumbnailKey(
  prefix: string, serviceId: number | string, name: string, variant?: string,
): string {
  return `${prefix}/${PROFESSIONAL_SERVICES_FOLDER}/${serviceId}-${sanitizeProfessionalServiceImageName(name)}${variant ? `-${variant}` : ''}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `professional_services/`, outermost first. */
export function professionalServiceImageFolderKeys(prefix: string): string[] {
  return [`${prefix}/`, `${prefix}/${PROFESSIONAL_SERVICES_FOLDER}/`];
}

/**
 * Whether the object behind `url` is one **under `prefix`'s `professional_services/`**
 * and so may be deleted when a service's image is replaced, moved or removed
 * (#719 §19 narrowed to this feature): another gym's folder, the platform's
 * (from a gym), another feature's object and an external URL are all false.
 */
export function isOwnedProfessionalServiceImageUrl(
  url: string | null | undefined,
  prefix: string | null | undefined,
): boolean {
  if (!url || !prefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${prefix}/${PROFESSIONAL_SERVICES_FOLDER}/`);
}

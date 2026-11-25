// Where a **Base Payment Method**'s image lives and which objects may be deleted
// (#1702). The pipeline is the Nutrition Goal's (#1623) and the Member photo's
// (#1449) — a WebP master and a WebP thumbnail the server makes from one uploaded
// original — so request judgement and processing are `member-image-storage.ts`'
// and `memberImageProcessing.ts`'; this file owns only *where the image goes* and
// *what may be removed*. Pure: no database, no bucket.
//
// The catalogue is platform-owned, so there is one root: `cordel/payment_method/
// <id>-<slug>.webp` (and `-thumbnail.webp`). Since #3350 stage 3 the identifier
// is the method's persisted slug (`imageKeyIdentifier()`), never its name.

import {
  PAYMENT_METHOD_FOLDER,
  PLATFORM_STORAGE_ROOT,
  sanitizeStorageObjectName,
  storageKeyFromObjectUrl,
} from '../infra/storage';

export { PAYMENT_METHOD_FOLDER };

const MAX_KEY_NAME_CHARS = 80;

/** A method's name as it appears in an object key: `Google Pay` → `Google-Pay`. */
export function sanitizePaymentMethodImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'payment-method').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

/**
 * The fallback the key carries for a method with no slug (#3350): the English
 * name (the catalogue's base language), else the stable `code`. Never the locale on screen, or a language switch
 * would move the object.
 */
export function paymentMethodImageName(translations: Record<string, { name: string }> | undefined, code: string): string {
  return translations?.en?.name?.trim() || code;
}

export function buildPaymentMethodImageKey(id: number | string, slug: string): string {
  return `${PLATFORM_STORAGE_ROOT}/${PAYMENT_METHOD_FOLDER}/${id}-${sanitizePaymentMethodImageName(slug)}.webp`;
}

export function buildPaymentMethodImageThumbnailKey(id: number | string, slug: string): string {
  return `${PLATFORM_STORAGE_ROOT}/${PAYMENT_METHOD_FOLDER}/${id}-${sanitizePaymentMethodImageName(slug)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `payment_method/`, outermost first. */
export function paymentMethodImageFolderKeys(): string[] {
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_STORAGE_ROOT}/${PAYMENT_METHOD_FOLDER}/`];
}

/** Whether the object behind `url` is under `cordel/payment_method/` and so may be deleted. */
export function isOwnedPaymentMethodImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  return !!key && key.startsWith(`${PLATFORM_STORAGE_ROOT}/${PAYMENT_METHOD_FOLDER}/`);
}

// Where a **muscle's** images live, what counts as a valid one, and which
// objects a platform operation may delete (#1368 stage 3, #1412).
//
// A muscle is a global catalogue row (`muscles`, no `gym_id`) administered from
// Cordel, so its images go in the platform's own folder. Since #1412 a muscle has
// one image per sex, each a 1080x1080 WebP master plus a 256x256 WebP thumbnail:
// `cordel/muscles/images/<muscle name>-<male|female>[-thumbnail].webp`. Upload,
// replacement and removal act on one sex at a time.
//
// Everything here is pure: the keys, the validation and the ownership test.

import { PLATFORM_STORAGE_ROOT, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';
import { readWebpMetadata } from './webpImage';

/** The first-level folder under `cordel/`, spelled once. */
export const MUSCLES_FOLDER = 'muscles';
export const MUSCLES_IMAGES_FOLDER = `${MUSCLES_FOLDER}/images`;

/** `cordel/muscles/images` — the one folder every muscle image is stored in. */
export const PLATFORM_MUSCLE_IMAGES_PREFIX = `${PLATFORM_STORAGE_ROOT}/${MUSCLES_IMAGES_FOLDER}`;

const MAX_KEY_NAME_CHARS = 80;

/** A muscle name as it appears in an object key (`Middle Back` → `Middle-Back`). */
export function sanitizeMuscleImageName(name: string): string {
  return sanitizeStorageObjectName(name, 'muscle').slice(0, MAX_KEY_NAME_CHARS).replace(/-$/, '');
}

export const MUSCLE_SEXES = ['male', 'female'] as const;
export type MuscleSex = (typeof MUSCLE_SEXES)[number];

export function parseMuscleSex(value: unknown): MuscleSex | null {
  return typeof value === 'string' && (MUSCLE_SEXES as readonly string[]).includes(value) ? (value as MuscleSex) : null;
}

/** The `muscles` columns that hold one sex's pair. */
export const MUSCLE_IMAGE_COLUMNS: Record<MuscleSex, { image: string; thumbnail: string }> = {
  male: { image: 'image_male_url', thumbnail: 'image_male_url_thumbnail' },
  female: { image: 'image_female_url', thumbnail: 'image_female_url_thumbnail' },
};

export const MUSCLE_IMAGE_MIME = 'image/webp';
export const MUSCLE_IMAGE_MASTER_SIZE = 1080;
export const MUSCLE_IMAGE_THUMBNAIL_SIZE = 256;
export const MUSCLE_IMAGE_MASTER_MAX_BYTES = 8 * 1024 * 1024;
export const MUSCLE_IMAGE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** `cordel/muscles/images/<muscle name>-<sex>.webp` — the 1080x1080 master. */
export function buildMuscleImageKey(name: string, sex: MuscleSex): string {
  return `${PLATFORM_MUSCLE_IMAGES_PREFIX}/${sanitizeMuscleImageName(name)}-${sex}.webp`;
}

/** The same key with `-thumbnail` before the extension — the 256x256 companion. */
export function buildMuscleImageThumbnailKey(name: string, sex: MuscleSex): string {
  return `${PLATFORM_MUSCLE_IMAGES_PREFIX}/${sanitizeMuscleImageName(name)}-${sex}-thumbnail.webp`;
}

export interface MuscleImageProblem {
  rejection: 'not_webp' | 'wrong_size' | 'too_large';
  message: string;
  kind: 'image' | 'thumbnail';
}

function validateOne(body: unknown, kind: 'image' | 'thumbnail'): MuscleImageProblem | null {
  const label = kind === 'image' ? 'Image' : 'Thumbnail';
  const size = kind === 'image' ? MUSCLE_IMAGE_MASTER_SIZE : MUSCLE_IMAGE_THUMBNAIL_SIZE;
  const max = kind === 'image' ? MUSCLE_IMAGE_MASTER_MAX_BYTES : MUSCLE_IMAGE_THUMBNAIL_MAX_BYTES;
  if (!Buffer.isBuffer(body)) return { kind, rejection: 'not_webp', message: `${label} must be a WebP file` };
  if (body.length > max) return { kind, rejection: 'too_large', message: `${label} exceeds the ${max / (1024 * 1024)} MB limit` };
  const meta = readWebpMetadata(body);
  if (!meta) return { kind, rejection: 'not_webp', message: `${label} must be a WebP file` };
  if (meta.width !== size || meta.height !== size) {
    return { kind, rejection: 'wrong_size', message: `${label} must be exactly ${size}×${size} pixels` };
  }
  return null;
}

/** Validates the pair from the bytes; the master first, and both before anything is uploaded. */
export function validateMuscleImagePair(image: unknown, thumbnail: unknown): MuscleImageProblem | null {
  return validateOne(image, 'image') ?? validateOne(thumbnail, 'thumbnail');
}

/**
 * Folder markers between the bucket root and `cordel/muscles/images/`,
 * outermost first. Gym Bucket Initialization never writes `cordel/`, so the
 * first upload creates the branch it needs.
 */
export function muscleImageFolderKeys(): string[] {
  return [
    `${PLATFORM_STORAGE_ROOT}/`,
    `${PLATFORM_STORAGE_ROOT}/${MUSCLES_FOLDER}/`,
    `${PLATFORM_MUSCLE_IMAGES_PREFIX}/`,
  ];
}

/**
 * Whether the object behind `url` is a muscle image of this deployment and may
 * therefore be deleted when it is replaced or removed. A gym's object, another
 * feature's `cordel/…` object and an external URL are never ours to delete.
 */
export function isPlatformOwnedMuscleImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${PLATFORM_MUSCLE_IMAGES_PREFIX}/`);
}

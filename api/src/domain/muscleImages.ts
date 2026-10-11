// Where a **muscle's** image lives, and which objects a platform operation may
// delete (#1368 stage 3).
//
// A muscle is a global catalogue row (`muscles`, no `gym_id`) administered from
// Cordel, so its image goes in the platform's own folder, as the issue's thread
// settles: `cordel/muscles/images/<muscle name>.png` plus `<muscle name>-thumbnail.png`.
// It is the Base Exercise image pair one folder over, so what counts as a valid
// image is not restated: the routes call `validateExerciseImagePair()`
// (2048×2048 master, 512×512 thumbnail).
//
// Everything here is pure: the keys and the ownership test.

import { PLATFORM_STORAGE_ROOT, sanitizeStorageObjectName, storageKeyFromObjectUrl } from '../infra/storage';

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

/** `cordel/muscles/images/<muscle name>.png` — the 2048×2048 master. */
export function buildMuscleImageKey(name: string): string {
  return `${PLATFORM_MUSCLE_IMAGES_PREFIX}/${sanitizeMuscleImageName(name)}.png`;
}

/** The same key with `-thumbnail` before the extension — the 512×512 companion. */
export function buildMuscleImageThumbnailKey(name: string): string {
  return `${PLATFORM_MUSCLE_IMAGES_PREFIX}/${sanitizeMuscleImageName(name)}-thumbnail.png`;
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

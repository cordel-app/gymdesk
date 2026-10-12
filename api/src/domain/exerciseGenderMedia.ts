// Gender-specific exercise media: where it lives, what counts as a valid upload
// and which objects an operation may delete (#1420).
//
// An exercise has a male and a female image and a male and a female video. Only
// the **master** URL is stored (`image_male_url`, `image_female_url`,
// `video_male_url`, `video_female_url`); the companions are derived from it by
// the naming convention below, so no thumbnail column exists:
//
//   images/<id>-<name>-<gender>.webp              1080x1080 master  (stored)
//   images/<id>-<name>-<gender>-thumbnail.webp     256x256          (derived)
//   videos/<id>-<name>-<gender>.mp4               the video         (stored)
//   videos/<id>-<name>-<gender>.webp              1080x1080 preview (derived)
//   videos/<id>-<name>-<gender>-thumbnail.webp     256x256          (derived)
//
// A video's preview stays under `videos/`: it belongs to the video and must never
// replace a separately uploaded image. The gender suffix is mandatory on every
// file, thumbnails included.
//
// Everything here is pure; the routes (`api/exercise-gender-media.ts`) own the
// bytes, the row and the authorization. The browser produces the WebP files (the
// answer on the ticket) and the server validates each file from its own bytes.

import { PLATFORM_STORAGE_ROOT, storageKeyFromObjectUrl } from '../infra/storage';
import {
  EXERCISE_FOLDER,
  EXERCISE_IMAGES_FOLDER,
  isGymOwnedImageUrl,
  sanitizeExerciseImageName,
} from './exerciseImages';
import { EXERCISE_VIDEOS_FOLDER, validateExerciseVideo } from './exerciseVideos';
import { readWebpMetadata } from './webpImage';

export const EXERCISE_GENDERS = ['male', 'female'] as const;
export type ExerciseGender = (typeof EXERCISE_GENDERS)[number];

/** `male` | `female`, or null for anything else (a 400 at the route, never a coercion). */
export function parseExerciseGender(value: unknown): ExerciseGender | null {
  return typeof value === 'string' && (EXERCISE_GENDERS as readonly string[]).includes(value)
    ? (value as ExerciseGender)
    : null;
}

/** The `exercises` columns that hold one gender's master references. */
export const EXERCISE_GENDER_MEDIA_COLUMNS: Record<ExerciseGender, { image: string; video: string }> = {
  male: { image: 'image_male_url', video: 'video_male_url' },
  female: { image: 'image_female_url', video: 'video_female_url' },
};

/** Every gender-specific column, for the paths that copy or compare them all. */
export const EXERCISE_GENDER_MEDIA_COLUMN_LIST = [
  'image_male_url',
  'image_female_url',
  'video_male_url',
  'video_female_url',
] as const;

export const EXERCISE_GENDER_IMAGE_MIME = 'image/webp';
export const EXERCISE_GENDER_VIDEO_MIME = 'video/mp4';
export const EXERCISE_GENDER_IMAGE_MASTER_SIZE = 1080;
export const EXERCISE_GENDER_IMAGE_THUMBNAIL_SIZE = 256;
export const EXERCISE_GENDER_IMAGE_MASTER_MAX_BYTES = 8 * 1024 * 1024;
export const EXERCISE_GENDER_IMAGE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

// ─── Keys ─────────────────────────────────────────────────────────────────────

const stem = (id: number | string, name: string, gender: ExerciseGender) =>
  `${id}-${sanitizeExerciseImageName(name)}-${gender}`;

/** `<gym prefix>/exercises/images/<id>-<name>-<gender>.webp` */
export function buildGymExerciseGenderImageKey(prefix: string, id: number | string, name: string, gender: ExerciseGender): string {
  return `${prefix}/${EXERCISE_IMAGES_FOLDER}/${stem(id, name, gender)}.webp`;
}

/** `<gym prefix>/exercises/videos/<id>-<name>-<gender>.mp4` */
export function buildGymExerciseGenderVideoKey(prefix: string, id: number | string, name: string, gender: ExerciseGender): string {
  return `${prefix}/${EXERCISE_VIDEOS_FOLDER}/${stem(id, name, gender)}.mp4`;
}

/** `cordel/exercises/images/<id>-<name>-<gender>.webp` */
export function buildBaseExerciseGenderImageKey(id: number | string, name: string, gender: ExerciseGender): string {
  return `${PLATFORM_STORAGE_ROOT}/${EXERCISE_IMAGES_FOLDER}/${stem(id, name, gender)}.webp`;
}

/** `cordel/exercises/videos/<id>-<name>-<gender>.mp4` */
export function buildBaseExerciseGenderVideoKey(id: number | string, name: string, gender: ExerciseGender): string {
  return `${PLATFORM_STORAGE_ROOT}/${EXERCISE_VIDEOS_FOLDER}/${stem(id, name, gender)}.mp4`;
}

/** The key beside `key` with `-thumbnail` before the `.webp` extension. */
export function thumbnailKeyFor(masterKey: string): string {
  return masterKey.replace(/\.webp$/, '-thumbnail.webp');
}

/** The WebP preview key that sits beside a video key (`….mp4` → `….webp`). */
export function videoPreviewKeyFor(videoKey: string): string {
  return videoKey.replace(/\.mp4$/, '.webp');
}

const swapSuffix = (url: string | null | undefined, from: RegExp, to: string): string | null => {
  if (!url) return null;
  const queryAt = url.search(/[?#]/);
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const tail = queryAt === -1 ? '' : url.slice(queryAt);
  return from.test(path) ? path.replace(from, to) + tail : null;
};

/** The thumbnail URL of an image master URL, or null when the URL is not a `.webp`. */
export function imageThumbnailUrlFor(masterUrl: string | null | undefined): string | null {
  return swapSuffix(masterUrl, /\.webp$/, '-thumbnail.webp');
}

/** The 1080x1080 WebP preview URL of a video URL, or null when it is not one of ours (`.mp4`). */
export function videoPreviewUrlFor(videoUrl: string | null | undefined): string | null {
  return swapSuffix(videoUrl, /\.mp4$/, '.webp');
}

/** The 256x256 preview thumbnail URL of a video URL. */
export function videoPreviewThumbnailUrlFor(videoUrl: string | null | undefined): string | null {
  return swapSuffix(videoUrl, /\.mp4$/, '-thumbnail.webp');
}

/**
 * Adds the derived companions to a read row (`SELECT e.*`): `image_male_thumbnail_url`,
 * `image_female_thumbnail_url`, and per video the `video_<gender>_preview_url` and
 * `video_<gender>_preview_thumbnail_url`. Each is null when its master is.
 */
export function withGenderMediaCompanions<T extends Record<string, any>>(row: T): T & Record<string, string | null> {
  if (!row) return row as any;
  return {
    ...row,
    image_male_thumbnail_url: imageThumbnailUrlFor(row.image_male_url),
    image_female_thumbnail_url: imageThumbnailUrlFor(row.image_female_url),
    video_male_preview_url: videoPreviewUrlFor(row.video_male_url),
    video_male_preview_thumbnail_url: videoPreviewThumbnailUrlFor(row.video_male_url),
    video_female_preview_url: videoPreviewUrlFor(row.video_female_url),
    video_female_preview_thumbnail_url: videoPreviewThumbnailUrlFor(row.video_female_url),
  };
}

/** The objects behind a stored image master: itself and its thumbnail. */
export function imageObjectUrls(masterUrl: string | null | undefined): string[] {
  if (!masterUrl) return [];
  const thumbnail = imageThumbnailUrlFor(masterUrl);
  return thumbnail ? [masterUrl, thumbnail] : [masterUrl];
}

/** The objects behind a stored video: itself, its preview and the preview's thumbnail. */
export function videoObjectUrls(videoUrl: string | null | undefined): string[] {
  if (!videoUrl) return [];
  const preview = videoPreviewUrlFor(videoUrl);
  const thumbnail = videoPreviewThumbnailUrlFor(videoUrl);
  return [videoUrl, ...(preview ? [preview] : []), ...(thumbnail ? [thumbnail] : [])];
}

/** Folder markers from the bucket root to a gym's `exercises/images/` (or `videos/`). */
export function gymExerciseGenderFolderKeys(prefix: string, kind: 'image' | 'video'): string[] {
  const leaf = kind === 'image' ? EXERCISE_IMAGES_FOLDER : EXERCISE_VIDEOS_FOLDER;
  return [`${prefix}/`, `${prefix}/${EXERCISE_FOLDER}/`, `${prefix}/${leaf}/`];
}

/** Folder markers from the bucket root to `cordel/exercises/images/` (or `videos/`). */
export function baseExerciseGenderFolderKeys(kind: 'image' | 'video'): string[] {
  const leaf = kind === 'image' ? EXERCISE_IMAGES_FOLDER : EXERCISE_VIDEOS_FOLDER;
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_STORAGE_ROOT}/${EXERCISE_FOLDER}/`, `${PLATFORM_STORAGE_ROOT}/${leaf}/`];
}

// ─── Ownership ────────────────────────────────────────────────────────────────

/** Whether a gym operation may delete this object: only one under the gym's own prefix (#719 §19). */
export function isGymOwnedGenderMediaUrl(url: string | null | undefined, prefix: string | null | undefined): boolean {
  return isGymOwnedImageUrl(url, prefix);
}

/**
 * Whether a platform operation may delete this object: only one under
 * `cordel/exercises/images/` or `cordel/exercises/videos/`. A gym's object and an
 * external link are never the platform's to delete.
 */
export function isPlatformOwnedGenderMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return (
    key.startsWith(`${PLATFORM_STORAGE_ROOT}/${EXERCISE_IMAGES_FOLDER}/`) ||
    key.startsWith(`${PLATFORM_STORAGE_ROOT}/${EXERCISE_VIDEOS_FOLDER}/`)
  );
}

// ─── Upload rules ─────────────────────────────────────────────────────────────

export type GenderMediaFile = 'image' | 'thumbnail' | 'video' | 'preview' | 'preview_thumbnail';

export interface GenderMediaProblem {
  file: GenderMediaFile;
  rejection: 'not_webp' | 'wrong_size' | 'too_large' | 'not_an_mp4' | 'no_video_track' | 'unsupported_codec';
  message: string;
}

const LABEL: Record<'image' | 'thumbnail' | 'preview' | 'preview_thumbnail', string> = {
  image: 'Image',
  thumbnail: 'Thumbnail',
  preview: 'Video preview',
  preview_thumbnail: 'Video preview thumbnail',
};

function validateWebp(
  body: unknown,
  file: 'image' | 'thumbnail' | 'preview' | 'preview_thumbnail',
): GenderMediaProblem | null {
  const isThumb = file === 'thumbnail' || file === 'preview_thumbnail';
  const size = isThumb ? EXERCISE_GENDER_IMAGE_THUMBNAIL_SIZE : EXERCISE_GENDER_IMAGE_MASTER_SIZE;
  const max = isThumb ? EXERCISE_GENDER_IMAGE_THUMBNAIL_MAX_BYTES : EXERCISE_GENDER_IMAGE_MASTER_MAX_BYTES;
  const label = LABEL[file];
  // A string or an array carries `length` and numeric indices, so either would
  // flow into the checks below as if it were bytes.
  if (!Buffer.isBuffer(body)) return { file, rejection: 'not_webp', message: `${label} must be a WebP file` };
  if (body.length > max) {
    return { file, rejection: 'too_large', message: `${label} exceeds the ${max / (1024 * 1024)} MB limit` };
  }
  const meta = readWebpMetadata(body);
  if (!meta) return { file, rejection: 'not_webp', message: `${label} must be a WebP file` };
  if (meta.width !== size || meta.height !== size) {
    return { file, rejection: 'wrong_size', message: `${label} must be exactly ${size}×${size} pixels` };
  }
  return null;
}

/** An image upload: the 1080x1080 WebP master and its 256x256 thumbnail. Both must pass. */
export function validateGenderImagePair(image: unknown, thumbnail: unknown): GenderMediaProblem | null {
  return validateWebp(image, 'image') ?? validateWebp(thumbnail, 'thumbnail');
}

/**
 * A video upload: the MP4 and the WebP preview pair captured from it. The video is
 * checked first so the clearer error wins, and all three must pass before anything
 * is uploaded.
 */
export function validateGenderVideoTriple(video: unknown, preview: unknown, previewThumbnail: unknown): GenderMediaProblem | null {
  const videoProblem = validateExerciseVideo(video);
  if (videoProblem) {
    return { file: 'video', rejection: videoProblem.rejection as GenderMediaProblem['rejection'], message: videoProblem.message };
  }
  return validateWebp(preview, 'preview') ?? validateWebp(previewThumbnail, 'preview_thumbnail');
}

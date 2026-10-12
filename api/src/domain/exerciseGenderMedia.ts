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
// bytes, the row and the authorization. The **server** makes every WebP file
// (`exerciseImageProcessing.ts`, #1420): a client sends the picture it picked as
// it is and the server judges it from its decoded bytes. A video is the one
// exception to "the client sends one picture": `sharp` cannot decode MP4, so the
// browser captures a frame and sends it beside the video, and the server
// processes that frame exactly like an image upload.

import { PLATFORM_STORAGE_ROOT, storageKeyFromObjectUrl } from '../infra/storage';
import {
  EXERCISE_FOLDER,
  EXERCISE_IMAGES_FOLDER,
  isGymOwnedImageUrl,
  sanitizeExerciseImageName,
} from './exerciseImages';
import { EXERCISE_VIDEOS_FOLDER, exerciseVideoMaxBytes, validateExerciseVideo } from './exerciseVideos';

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

/** What the server will decode: a camera original in any of these, never judged by its header or name. */
export const EXERCISE_IMAGE_INPUT_FORMATS = ['jpeg', 'png', 'webp', 'gif'] as const;

/** Largest picture, in pixels, the server will decode (a 50-megapixel camera). */
export const EXERCISE_IMAGE_MAX_PIXELS = 50_000_000;

const DEFAULT_IMAGE_MAX_MB = 10;
const CEILING_IMAGE_MAX_MB = 25;

/**
 * The upload ceiling of one picture in bytes: `EXERCISE_IMAGE_MAX_MB`, default 10,
 * never above 25 so a typo cannot make the buffered request body unbounded. It is
 * configuration rather than a constant, like `MEMBER_IMAGE_MAX_MB`.
 */
export function exerciseImageMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXERCISE_IMAGE_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? Math.min(raw, CEILING_IMAGE_MAX_MB) : DEFAULT_IMAGE_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

export const EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_DEFAULT_MAX = 30;

/**
 * Exercise media uploads one signed-in person may make per window, on top of the
 * global budget (#1395): decoding and encoding a picture is not a cheap `POST`.
 * `EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_MAX`, default 30, a positive integer.
 */
export function exerciseMediaUploadRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_MAX);
  return Number.isInteger(raw) && raw > 0 ? raw : EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_DEFAULT_MAX;
}

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

export type GenderMediaFile = 'image' | 'frame' | 'video';

export type ExerciseImageRejection = 'unreadable' | 'unsupported_format' | 'too_many_pixels';

export interface GenderMediaProblem {
  file: GenderMediaFile;
  rejection:
    | ExerciseImageRejection
    | 'not_an_image'
    | 'too_large'
    | 'not_an_mp4'
    | 'no_video_track'
    | 'unsupported_codec';
  message: string;
}

export const EXERCISE_IMAGE_REJECTION_MESSAGES: Record<ExerciseImageRejection, string> = {
  unreadable: 'The file could not be read as an image',
  unsupported_format: 'Image must be a JPEG, PNG, WebP or GIF file',
  too_many_pixels: `Image is too large: at most ${EXERCISE_IMAGE_MAX_PIXELS / 1_000_000} megapixels`,
};

const LABEL: Record<'image' | 'frame', string> = { image: 'Image', frame: 'Video frame' };

/**
 * The envelope of one picture a request carries — the `image` of an image upload
 * or the `frame` of a video upload: it must be bytes (a string or an array
 * carries `length` and numeric indices and would otherwise pass for them) within
 * the configured ceiling. Whether the bytes are a picture is the decode's answer.
 */
export function validateGenderImageInput(body: unknown, file: 'image' | 'frame'): GenderMediaProblem | null {
  const label = LABEL[file];
  if (!Buffer.isBuffer(body)) return { file, rejection: 'not_an_image', message: `${label} must be an image file` };
  const max = exerciseImageMaxBytes();
  if (body.length > max) {
    return { file, rejection: 'too_large', message: `${label} exceeds the ${Math.floor(max / (1024 * 1024))} MB limit` };
  }
  return null;
}

/** The video of a video upload, judged from its bytes (`validateExerciseVideo()`, unchanged). */
export function validateGenderVideo(video: unknown): GenderMediaProblem | null {
  const problem = validateExerciseVideo(video);
  if (!problem) return null;
  return { file: 'video', rejection: problem.rejection as GenderMediaProblem['rejection'], message: problem.message };
}

/** The ceiling of a whole upload request, for the JSON body parser: the video, one picture, base64's overhead. */
export function genderMediaRequestMaxBytes(): number {
  return Math.ceil((exerciseVideoMaxBytes() + exerciseImageMaxBytes()) * 1.4);
}

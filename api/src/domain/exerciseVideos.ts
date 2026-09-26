// Where a **Gym Exercise** video and its poster live, and what counts as a valid
// upload (#719 part 2).
//
// The sibling of `exerciseImages.ts` (part 1) and built the same way: the object
// keys and the upload rules are pure and live here, the router owns the bytes,
// the row and the authorization. Ownership — "may this gym delete that object?"
// — is not restated: it is one rule for every kind of exercise media, so this
// module re-exports `isGymOwnedImageUrl()` rather than growing a second copy
// that could drift from it.

import { sanitizeExerciseImageName } from './exerciseImages';
import { readPngMetadata } from './pngImage';
import { isMp4Brand, readMp4Metadata, videoCodecNames } from './mp4Video';

/**
 * `Exercises/Videos` — the leaf of the gym's own folder tree (`GYM_FOLDERS` in
 * `infra/storage.ts`) that holds exercise videos. #719 §18 fixes it: a gym's
 * upload goes here and never under `cordel/Exercises/Videos/`, which stays the
 * platform's (#717).
 */
export const EXERCISE_VIDEOS_FOLDER = 'Exercises/Videos';

/**
 * `<gym prefix>/Exercises/Videos/<exercise_id>-<sanitized name>.mp4` — the key a
 * Gym Exercise's video is stored under (#719 §7).
 *
 * Same construction as the image keys: the id leads so two exercises whose names
 * sanitize alike never share an object, the name is capped by
 * `sanitizeExerciseImageName()` so the resulting URL cannot outgrow its column,
 * and the extension is part of the fixed name rather than a claim about the
 * bytes — only MP4 is accepted, so the two cannot disagree. The uploaded file's
 * own name plays no part in the key (#713's rule).
 */
export function buildGymExerciseVideoKey(folderPrefix: string, exerciseId: number | string, name: string): string {
  return `${folderPrefix}/${EXERCISE_VIDEOS_FOLDER}/${exerciseId}-${sanitizeExerciseImageName(name)}.mp4`;
}

/**
 * The poster's key — `…-thumbnail.png` beside the video (#719 §7), so the UI can
 * draw a video without downloading the MP4 (§15, §17). It is a PNG next to an
 * MP4 on purpose: the poster is an image, and naming it after the video it
 * belongs to is what keeps the pair legible in the bucket.
 */
export function buildGymExerciseVideoPosterKey(folderPrefix: string, exerciseId: number | string, name: string): string {
  return `${folderPrefix}/${EXERCISE_VIDEOS_FOLDER}/${exerciseId}-${sanitizeExerciseImageName(name)}-thumbnail.png`;
}

/**
 * Every folder marker between the bucket root and the gym's
 * `Exercises/Videos/`, outermost first — the same belt-and-braces
 * `gymExerciseImageFolderKeys()` applies for a gym whose tree predates a folder.
 */
export function gymExerciseVideoFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/Exercises/`, `${folderPrefix}/${EXERCISE_VIDEOS_FOLDER}/`];
}

// ─── Upload rules (#719 §7, §21) ──────────────────────────────────────────────

/** MP4 only: the key is named `.mp4` and §7 fixes the format. */
export const EXERCISE_VIDEO_MIME = 'video/mp4';

/** The poster is a PNG, like every other image this codebase stores. */
export const EXERCISE_VIDEO_POSTER_MIME = 'image/png';

/**
 * 512 × 512 — the same tile the image thumbnail fills (part 1), because the two
 * are drawn side by side in a workout row (§16) and a poster of another shape
 * would make the row jump. The **browser** produces it by drawing one frame of
 * the video into a square canvas (the answer on #719 Q2), so the crop is a
 * decision the client makes and the server only checks the result.
 *
 * Deliberately *not* required to carry an alpha channel, which is where a poster
 * parts company with an exercise image: a frame of video is opaque by nature, and
 * demanding transparency would reject every valid poster.
 */
export const EXERCISE_VIDEO_POSTER_SIZE = 512;

/** 2 MB — the same ceiling part 1 puts on a 512 × 512 thumbnail. */
export const EXERCISE_VIDEO_POSTER_MAX_BYTES = 2 * 1024 * 1024;

/** What `EXERCISE_VIDEO_MAX_MB` defaults to when the deployment sets nothing. */
export const EXERCISE_VIDEO_DEFAULT_MAX_MB = 50;

/**
 * Hard ceiling on `EXERCISE_VIDEO_MAX_MB`. The upload is buffered in the API
 * process (the storage layer does a single `PutObject`, and there is no
 * multipart or presigned path in this codebase), so the cap is what bounds that
 * memory — a deployment may lower it freely, but not raise it past what the
 * process can hold per request.
 */
export const EXERCISE_VIDEO_MAX_MB_CEILING = 200;

/**
 * How large a Gym Exercise video may be, in bytes.
 *
 * Configurable because the right answer is a deployment's, not the code's — a
 * demonstration clip of one exercise is a few megabytes, but a gym filming in
 * 4K is not wrong to want more headroom. Read per call rather than captured at
 * import time, so a test (and a restart-free change) sees the current value.
 */
export function exerciseVideoMaxBytes(): number {
  const raw = Number(process.env.EXERCISE_VIDEO_MAX_MB);
  const megabytes = Number.isFinite(raw) && raw > 0
    ? Math.min(raw, EXERCISE_VIDEO_MAX_MB_CEILING)
    : EXERCISE_VIDEO_DEFAULT_MAX_MB;
  return Math.floor(megabytes * 1024 * 1024);
}

/** Which of the two files a rejection is about, so the message can name it. */
export type ExerciseVideoKind = 'video' | 'poster';

/** Why an upload was refused — the router maps each to a status and a message. */
export type ExerciseVideoRejection =
  | 'not_an_mp4'
  | 'no_video_track'
  | 'unsupported_codec'
  | 'not_a_png'
  | 'wrong_size'
  | 'too_large';

export interface ExerciseVideoProblem {
  kind: ExerciseVideoKind;
  rejection: ExerciseVideoRejection;
  message: string;
}

const problemOf = (
  kind: ExerciseVideoKind,
  rejection: ExerciseVideoRejection,
  message: string,
): ExerciseVideoProblem => ({ kind, rejection, message });

/**
 * Whether these bytes may be stored as a Gym Exercise video, and if not, why.
 *
 * Read from the file's own boxes (`domain/mp4Video.ts`), never from the
 * `Content-Type` header or the file name, both of which are the client's word —
 * §7 is explicit that the server validates independently of the browser. In
 * order: the size ceiling (cheap, and the only check a 200 MB upload should
 * reach), then the container brand, then the movie header, then a video track
 * whose codec is one a browser can play.
 *
 * A rejection means nothing is uploaded and nothing is written, so the video
 * already on the exercise stays exactly as it was (§9).
 */
export function validateExerciseVideo(body: unknown): ExerciseVideoProblem | null {
  const maxBytes = exerciseVideoMaxBytes();
  if (!Buffer.isBuffer(body)) return problemOf('video', 'not_an_mp4', 'Video must be an MP4 file');
  if (body.length > maxBytes) {
    return problemOf('video', 'too_large', `Video exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
  }
  const metadata = readMp4Metadata(body);
  if (!metadata || !isMp4Brand(metadata)) {
    return problemOf('video', 'not_an_mp4', 'Video must be an MP4 file');
  }
  if (!metadata.hasMovieBox) {
    // No `moov` — a truncated upload, or an MP4 header glued to something else.
    return problemOf('video', 'not_an_mp4', 'Video is not a readable MP4 file');
  }
  if (metadata.videoSampleEntries.length === 0) {
    return problemOf('video', 'no_video_track', 'Video contains no video track');
  }
  // §7 prefers H.264 "where applicable", so another codec a browser plays is
  // accepted rather than refused; what is refused is a track this deployment
  // cannot name at all, which is the case a renamed or exotic file lands in.
  const codecs = videoCodecNames(metadata);
  if (codecs.length === 0) {
    return problemOf('video', 'unsupported_codec', 'Video codec is not supported — use MP4 (H.264)');
  }
  return null;
}

/**
 * Whether these bytes may be stored as the video's poster: a PNG of exactly
 * {@link EXERCISE_VIDEO_POSTER_SIZE} square, read from the IHDR rather than from
 * anything the client claimed. Transparency is not required — see
 * {@link EXERCISE_VIDEO_POSTER_SIZE}.
 */
export function validateExerciseVideoPoster(body: unknown): ExerciseVideoProblem | null {
  if (!Buffer.isBuffer(body)) return problemOf('poster', 'not_a_png', 'Video thumbnail must be a PNG file');
  if (body.length > EXERCISE_VIDEO_POSTER_MAX_BYTES) {
    return problemOf(
      'poster',
      'too_large',
      `Video thumbnail exceeds the ${EXERCISE_VIDEO_POSTER_MAX_BYTES / (1024 * 1024)} MB limit`,
    );
  }
  const metadata = readPngMetadata(body);
  if (!metadata) return problemOf('poster', 'not_a_png', 'Video thumbnail must be a PNG file');
  if (metadata.width !== EXERCISE_VIDEO_POSTER_SIZE || metadata.height !== EXERCISE_VIDEO_POSTER_SIZE) {
    return problemOf(
      'poster',
      'wrong_size',
      `Video thumbnail must be exactly ${EXERCISE_VIDEO_POSTER_SIZE}×${EXERCISE_VIDEO_POSTER_SIZE} pixels`,
    );
  }
  return null;
}

/**
 * Validates the pair an upload carries. The video is checked first so the
 * clearer error wins, and **both** must pass before anything is uploaded — the
 * answer on #719 Q2 is explicit that a failed thumbnail fails the whole upload
 * rather than storing a video without a poster (§9).
 */
export function validateExerciseVideoPair(video: unknown, poster: unknown): ExerciseVideoProblem | null {
  return validateExerciseVideo(video) ?? validateExerciseVideoPoster(poster);
}

export { isGymOwnedImageUrl as isGymOwnedMediaUrl } from './exerciseImages';

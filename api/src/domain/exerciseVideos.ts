// Where a **Gym Exercise** video and its poster live, and what counts as a valid
// upload (#719 part 2).
//
// The sibling of `exerciseImages.ts` (part 1) and built the same way: the object
// keys and the upload rules are pure and live here, the router owns the bytes,
// the row and the authorization. Ownership — "may this gym delete that object?"
// — is not restated: it is one rule for every kind of exercise media, so this
// module re-exports `isGymOwnedImageUrl()` rather than growing a second copy
// that could drift from it.

import { EXERCISE_VIDEOS_STORAGE_FOLDER } from '../infra/storage';
import { isMp4Brand, readMp4Metadata, videoCodecNames } from './mp4Video';

/**
 * `exercises/videos` — the leaf of the gym's own folder tree (`GYM_FOLDERS` in
 * `infra/storage.ts`) that holds exercise videos. #719 §18 fixes it: a gym's
 * upload goes here and never under `cordel/exercises/videos/`, which stays the
 * platform's (#717). Re-exported from `infra/storage.ts`, lowercase since #1035.
 */
export const EXERCISE_VIDEOS_FOLDER = EXERCISE_VIDEOS_STORAGE_FOLDER;

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
export type ExerciseVideoKind = 'video';

/** Why an upload was refused — the router maps each to a status and a message. */
export type ExerciseVideoRejection =
  | 'not_an_mp4'
  | 'no_video_track'
  | 'unsupported_codec'
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

export { isGymOwnedImageUrl as isGymOwnedMediaUrl } from './exerciseImages';

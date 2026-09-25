// Preparing a Gym Exercise video for `POST /exercises/:id/video` (#719 part 2).
//
// The browser is what produces the poster frame — the answer on #719 Q2, which
// rules out `sharp`/`ffmpeg` in the API image — so this module owns the three
// steps between a picked file and the request body: check what a browser can
// check, capture one frame into a 512 × 512 PNG, and encode both as base64.
//
// The server repeats every check from the files' own bytes (`domain/
// exerciseVideos.ts` + `domain/mp4Video.ts`), so nothing here is a security
// boundary: it exists to give a clear error *before* a multi-megabyte upload
// rather than instead of one. What it must get right is the rule the server
// cannot enforce — **if the poster cannot be captured, the upload does not
// happen at all**, so the existing video is never replaced by one the UI would
// have to download to draw a row.

import { blobToBase64 } from './exerciseImageUpload';

/** The square poster the server stores beside the video (#719 §7). */
export const EXERCISE_VIDEO_POSTER_SIZE = 512;

/** What `NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB` defaults to — the API's own default. */
export const EXERCISE_VIDEO_DEFAULT_MAX_MB = 50;

/**
 * How large a video this deployment accepts, in megabytes.
 *
 * Mirrors the API's `EXERCISE_VIDEO_MAX_MB` so the picker can refuse an
 * oversized file before spending minutes uploading it, and so the requirements
 * line quotes the real number. The server is still the authority: a mismatch
 * shows up as its 413, not as a silently truncated upload.
 */
export function exerciseVideoMaxMb(): number {
  const configured = Number(process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB);
  return Number.isFinite(configured) && configured > 0 ? configured : EXERCISE_VIDEO_DEFAULT_MAX_MB;
}

export type ExerciseVideoProblem =
  | 'not_an_mp4'
  | 'too_large'
  | 'unreadable'
  | 'poster_failed';

export interface PreparedExerciseVideo {
  /** Base64 of the picked file, byte for byte — never re-encoded. */
  video: string;
  /** Base64 of the 512 × 512 PNG this module captured from it. */
  poster: string;
}

/**
 * How far into the clip the poster frame is taken from.
 *
 * Not frame zero: the first frame of a demonstration video is very often black
 * or a title card, which makes a poster that says nothing about the exercise.
 * A short clip seeks to its midpoint instead, so there is always a frame to
 * take.
 */
export function posterTimestamp(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, duration / 2);
}

/** Gives up rather than hanging on a file the browser will never decode. */
const DECODE_TIMEOUT_MS = 15_000;

/**
 * Loads `file` into a detached `<video>`, seeks to {@link posterTimestamp} and
 * resolves once a frame is there to draw — or null when the browser cannot
 * decode it (which is also how a renamed non-video file fails here).
 */
async function decodeFirstFrame(url: string): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    const finish = (result: HTMLVideoElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), DECODE_TIMEOUT_MS);

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // Never attached to the document: this element exists to decode one frame,
    // and nothing about the picked file reaches the page's DOM.
    video.onerror = () => finish(null);
    video.onseeked = () => finish(video);
    video.onloadeddata = () => {
      // A stream whose duration the browser cannot report still has frame 0.
      const at = posterTimestamp(video.duration);
      if (at <= 0) return finish(video);
      try {
        video.currentTime = at;
      } catch {
        finish(video);
      }
    };
    // `url` is a `blob:` URL this module minted from a locally picked File one
    // line earlier, and `video` is never attached to the document — a media
    // element fetches and decodes its `src`, it does not parse HTML. CodeQL's
    // js/xss-through-dom reaches the opposite conclusion only because the
    // element came from `createElement('video')`: the identical `img.src = url`
    // in `exerciseImageUpload.ts` is unflagged, because `new Image()` resolves
    // to a known element type.
    //
    // Clearing that alert takes a dismissal in code scanning (#767), not a
    // change here. Inline suppression does not work in this repo — a preceding
    // `// codeql[js/xss-through-dom]` and a trailing `// lgtm[...]` were both
    // tried on this line and GitHub honoured neither — and the only rewrite
    // that cleared the sibling alert on #763 was handing the element a base64
    // `data:` URL, which here would be the whole clip (~67 MB at the 50 MB cap)
    // in a media element that then has to seek to the poster timestamp.
    video.src = url;
  });
}

/**
 * Draws one frame of `file` into a `size × size` PNG.
 *
 * The frame is cover-cropped from the centre rather than squeezed, so a 16:9
 * clip yields a square poster with the movement in it and nothing is distorted
 * (§5's "do not distort" applied to the poster). Returns null whenever the frame
 * cannot be produced — including a cross-origin taint, which `toBlob` reports as
 * a throw — because a video without a poster is not an upload this feature makes.
 */
export async function captureVideoPoster(file: Blob, size = EXERCISE_VIDEO_POSTER_SIZE): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const video = await decodeFirstFrame(url);
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The request body for `POST /exercises/:id/video`, or the reason there isn't
 * one. Every failure mode returns a problem rather than a partial body: the
 * caller uploads only when this resolves to a pair, which is what keeps a failed
 * poster from replacing the video already on the exercise.
 */
export async function prepareExerciseVideo(file: File): Promise<PreparedExerciseVideo | ExerciseVideoProblem> {
  if (file.type !== 'video/mp4' && !file.name.toLowerCase().endsWith('.mp4')) return 'not_an_mp4';
  if (file.size > exerciseVideoMaxMb() * 1024 * 1024) return 'too_large';

  const poster = await captureVideoPoster(file);
  // The browser decoding nothing at all and decoding a frame it cannot draw are
  // different failures for the person picking the file: the first means "this is
  // not a video I can read", the second "I could not make the poster".
  if (!poster) return file.size === 0 ? 'unreadable' : 'poster_failed';

  const [video, posterBase64] = await Promise.all([blobToBase64(file), blobToBase64(poster)]);
  return { video, poster: posterBase64 };
}

/** Whether a `prepareExerciseVideo()` result is the pair rather than a problem. */
export function isPreparedExerciseVideo(
  result: PreparedExerciseVideo | ExerciseVideoProblem,
): result is PreparedExerciseVideo {
  return typeof result !== 'string';
}

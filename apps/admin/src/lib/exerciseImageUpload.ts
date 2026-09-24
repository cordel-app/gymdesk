// Preparing a Gym Exercise image for `POST /exercises/:id/image` (#719 part 1).
//
// The browser is what produces the 512×512 thumbnail — the answer on #719 Q2,
// which rules out `sharp`/`ffmpeg` in the API image — so this module owns the
// three steps between a picked file and the request body: check what a browser
// can check, downscale the master to the thumbnail, and encode both as base64.
//
// The server repeats every check from the files' own bytes (`domain/
// exerciseImages.ts`), so nothing here is a security boundary: it exists to give
// a clear error *before* an upload rather than instead of one. What it must get
// right is the rule the server cannot enforce — **if the thumbnail cannot be
// produced, the upload does not happen at all**, so the existing image is never
// replaced by a master with no companion.

/** The 2048×2048 master #719 §5 requires. */
export const EXERCISE_IMAGE_MASTER_SIZE = 2048;

/** The 512×512 thumbnail every list row draws instead of the master (§15, §17). */
export const EXERCISE_IMAGE_THUMBNAIL_SIZE = 512;

export type ExerciseImageProblem =
  | 'not_a_png'
  | 'unreadable'
  | 'wrong_size'
  | 'thumbnail_failed';

export interface PreparedExerciseImage {
  /** Base64 of the picked file, byte for byte — never re-encoded. */
  image: string;
  /** Base64 of the 512×512 PNG this module drew from it. */
  thumbnail: string;
}

/** The only schemes an exercise image frame will draw. */
const SAFE_IMAGE_SRC = /^(?:https?:\/\/|blob:|data:image\/)/i;

/**
 * Whether a reference may be handed to an `<img src>`.
 *
 * Two kinds of string reach the frame: the `blob:` URL the browser minted for a
 * staged file, and whatever `exercises.image_{url,thumbnail_url}` holds — which
 * a `PUT` can set to any string, so it is not this component's to trust. Only
 * `http(s):`, `blob:` and `data:image/` are drawn; anything else renders as
 * "no image" rather than reaching the DOM.
 */
export function isSafeImageSrc(url: string | null | undefined): boolean {
  if (!url) return false;
  return SAFE_IMAGE_SRC.test(url);
}

/**
 * Natural size of an image file, or null when the browser cannot decode it.
 * Same helper shape as the Base Nutrition Library picker (#715).
 */
export async function readImageDimensions(file: Blob): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Base64 (no data: prefix) of a blob's bytes. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked so a multi-megabyte master doesn't blow the argument limit of
  // `String.fromCharCode(...)`.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Draws `file` into a `size × size` PNG and returns it.
 *
 * `alpha: true` and a canvas that is never filled are what preserve the
 * transparent background the server insists on (an opaque thumbnail is rejected
 * as `not_transparent`). The source is square by the time this runs — the
 * dimension check refuses anything else — so the draw is a plain downscale with
 * no cropping or letterboxing, and the image is neither distorted nor
 * re-centred (§5).
 */
export async function makeThumbnail(file: Blob, size = EXERCISE_IMAGE_THUMBNAIL_SIZE): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    if (!image) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, size, size);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The request body for `POST /exercises/:id/image`, or the reason there isn't
 * one. Every failure mode returns a problem rather than a partial body: the
 * caller uploads only when this resolves to a pair, which is what keeps a failed
 * thumbnail from replacing the image already on the exercise.
 */
export async function prepareExerciseImage(file: File): Promise<PreparedExerciseImage | ExerciseImageProblem> {
  if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) return 'not_a_png';

  const dimensions = await readImageDimensions(file);
  if (!dimensions) return 'unreadable';
  if (dimensions.width !== EXERCISE_IMAGE_MASTER_SIZE || dimensions.height !== EXERCISE_IMAGE_MASTER_SIZE) {
    return 'wrong_size';
  }

  const thumbnail = await makeThumbnail(file);
  if (!thumbnail) return 'thumbnail_failed';

  const [image, thumb] = await Promise.all([blobToBase64(file), blobToBase64(thumbnail)]);
  return { image, thumbnail: thumb };
}

/** Whether a `prepareExerciseImage()` result is the pair rather than a problem. */
export function isPreparedExerciseImage(
  result: PreparedExerciseImage | ExerciseImageProblem,
): result is PreparedExerciseImage {
  return typeof result !== 'string';
}
